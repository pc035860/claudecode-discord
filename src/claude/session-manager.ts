import {
  Agent,
  type LocalAgentOptions,
  type Run,
  type SDKAgent,
} from "@cursor/sdk";
import { Code, ConnectError } from "@connectrpc/connect";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
} from "../db/database.js";
import { getConfig } from "../utils/config.js";
import { maybeSelfRestart, isRestartScheduled } from "../utils/self-heal.js";
import { L } from "../utils/i18n.js";
import { ThreadReporter } from "./thread-reporter.js";
import {
  createResultEmbed,
  createStopButton,
  createCompletedButton,
  extractAttachments,
  sendAttachments,
} from "./output-formatter.js";

// tsup bundles to a flat dist/index.js, so depth from this module to repo
// root differs between tsx (src/claude/) and prod (dist/). Try both.
const BOT_RULES = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "rules", "BOT.md"),
    path.join(here, "..", "rules", "BOT.md"),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf8").trim();
    } catch {
      // try next
    }
  }
  console.warn(
    `[bot-rules] rules/BOT.md not found in candidates: ${candidates.join(", ")} — outbound [ATTACH:] convention will not be taught to fresh sessions.`,
  );
  return "";
})();

interface ActiveSession {
  agent: SDKAgent | null;
  run: Run | null;
  channelId: string;
  agentId: string | null;
  dbId: string;
  cancelRequested: boolean;
}

// Thunks so L() reads .tray-lang at call time (live language switch).
const TOOL_LABELS: Record<string, () => string> = {
  read: () => L("Reading files", "파일 읽는 중"),
  ls: () => L("Listing files", "파일 목록 보기"),
  glob: () => L("Searching files", "파일 검색 중"),
  grep: () => L("Searching code", "코드 검색 중"),
  write: () => L("Writing file", "파일 작성 중"),
  edit: () => L("Editing file", "파일 편집 중"),
  shell: () => L("Running command", "명령어 실행 중"),
  semSearch: () => L("Semantic search", "의미 검색 중"),
  task: () => L("Spawning subagent", "서브에이전트 시작 중"),
  mcp: () => L("Calling MCP tool", "MCP 도구 호출 중"),
};

export function formatToolDetail(name: string, input: Record<string, unknown>): string {
  // Cursor tools: shell, edit, read, write, glob, grep, ls, semSearch, task, mcp
  if (name === "task" && typeof input.description === "string") {
    const type = typeof input.subagent_type === "string" ? `[${input.subagent_type}] ` : "";
    return `${type}${input.description.slice(0, 80)}`;
  }
  if (typeof input.command === "string") return `\`${input.command.slice(0, 100)}\``;
  if (typeof input.pattern === "string") {
    const pathSuffix = typeof input.path === "string" ? ` in \`${input.path}\`` : "";
    return `\`${input.pattern}\`${pathSuffix}`;
  }
  if (typeof input.file_path === "string") return `\`${input.file_path}\``;
  if (typeof input.path === "string") return `\`${input.path}\``;
  if (typeof input.query === "string") return `"${input.query.slice(0, 80)}"`;
  if (typeof input.url === "string") return `${input.url.slice(0, 120)}`;
  if (typeof input.description === "string") return `${input.description.slice(0, 80)}`;
  return "";
}

const CONNECT_ERROR_REGEX = /^(?:ConnectError:\s*)?\[([a-z_]+)\]\s*(.*)$/is;
const RETRYABLE_CONNECT_CODES = new Set([
  "unavailable",
  "deadline_exceeded",
  "aborted",
]);
const MAX_RAW_ERROR_LEN = 200;
const ERROR_PREVIEW_LEN = 80;

export function isConnectError(
  err: unknown,
): err is Error & { code?: unknown; rawMessage?: unknown } {
  return (
    err instanceof ConnectError ||
    (err instanceof Error && err.name === "ConnectError")
  );
}

function shouldRetryAuth(
  err: unknown,
  state: { cancelled: boolean; runStarted: boolean },
): boolean {
  return (
    isConnectError(err) &&
    err.code === Code.Unauthenticated &&
    !isRestartScheduled() &&
    !state.cancelled &&
    !state.runStarted
  );
}

function formatConnectErrorMessage(code: string): string {
  if (code === "unauthenticated") {
    return L(
      `❌ Authentication broken — the bot's API connection has been corrupted. Please contact the admin to restart the bot. (code: ${code})`,
      `❌ 인증 오류 — 봇의 API 연결이 손상되었습니다. 관리자에게 봇 재시작을 요청해주세요. (code: ${code})`,
    );
  }
  if (RETRYABLE_CONNECT_CODES.has(code)) {
    return L(
      `⚠️ Cursor service temporarily unavailable. Please try again in a moment. (code: ${code})`,
      `⚠️ Cursor 서비스에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도하세요. (code: ${code})`,
    );
  }
  return L(
    `❌ Connection error from Cursor SDK (code: ${code}). If this keeps happening, please contact the admin to restart the bot.`,
    `❌ Cursor SDK 연결 오류 (code: ${code}). 계속 발생하면 관리자에게 봇 재시작을 요청하세요.`,
  );
}

export function parseApiError(rawMsg: string): string {
  const ceMatch = rawMsg.match(CONNECT_ERROR_REGEX);
  if (ceMatch) {
    return formatConnectErrorMessage(ceMatch[1].toLowerCase());
  }

  const jsonMatch = rawMsg.match(/API Error: (\d+)\s*(\{.*\})/s);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[2]);
      const statusCode = jsonMatch[1];
      const message = parsed?.error?.message ?? parsed?.message ?? "Unknown error";
      return `API Error ${statusCode}: ${message}. Please try again later.`;
    } catch {
      return `API Error ${jsonMatch[1]}. Please try again later.`;
    }
  } else if (rawMsg.includes("process exited with code")) {
    return `${rawMsg}. The server may be temporarily unavailable — please try again later.`;
  }
  if (rawMsg.length >= MAX_RAW_ERROR_LEN || rawMsg.includes("\n")) {
    const firstLine = rawMsg.split("\n")[0].slice(0, ERROR_PREVIEW_LEN);
    return L(
      `❌ Unexpected internal error. Please contact the admin if this persists. (${firstLine})`,
      `❌ 예상치 못한 내부 오류. 계속 발생하면 관리자에게 문의하세요. (${firstLine})`,
    );
  }
  return rawMsg;
}

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private static readonly MAX_QUEUE_SIZE = 5;
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string }[]>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string }>();

  async sendMessage(channel: TextChannel, prompt: string): Promise<void> {
    const channelId = channel.id;
    const project = getProject(channelId);
    if (!project) return;

    const existingSession = this.sessions.get(channelId);
    const dbSession = !existingSession ? getSession(channelId) : undefined;
    const dbId = existingSession?.dbId ?? dbSession?.id ?? randomUUID();
    const resumeAgentId = existingSession?.agentId ?? dbSession?.agent_id ?? null;

    upsertSession(dbId, channelId, resumeAgentId, "online");

    const stopRow = createStopButton(channelId);
    const currentMessage = await channel.send({
      content: L("⏳ Thinking...", "⏳ 생각 중..."),
      components: [stopRow],
    });

    const config = getConfig();
    let threadReporter: ThreadReporter | null = null;
    if (config.THREAD_PROGRESS) {
      threadReporter = new ThreadReporter(currentMessage);
      threadReporter.start();
    }

    const startTime = Date.now();
    let lastActivity = L("Thinking...", "생각 중...");
    let toolUseCount = 0;
    let sessionDone = false;

    let lastStatusContent = "";
    const renderStatus = async (): Promise<void> => {
      if (sessionDone) return;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      const toolSuffix = toolUseCount > 0 ? ` [${toolUseCount} tools used]` : "";
      const content = `⏳ ${lastActivity} (${timeStr})${toolSuffix}`;
      if (content === lastStatusContent) return;
      lastStatusContent = content;
      try {
        await currentMessage.edit({ content, components: [stopRow] });
      } catch (e) {
        console.warn(`[status] Failed to edit message for ${channelId}:`, e instanceof Error ? e.message : e);
      }
    };

    // Heartbeat keeps the elapsed-time fresh while waiting between tool events.
    const heartbeatInterval = setInterval(() => {
      renderStatus().catch(() => {});
    }, 15_000);

    const markDone = async () => {
      sessionDone = true;
      clearInterval(heartbeatInterval);
      try {
        await currentMessage.edit({ components: [createCompletedButton()] });
      } catch (e) {
        console.warn(`[complete] Failed to update completed button for ${channelId}:`, e instanceof Error ? e.message : e);
      }
    };

    // Reserve the channel slot BEFORE awaiting Agent.create / agent.send so
    // a second message arriving in the same channel doesn't bypass isActive()
    // and start a parallel run. agent/run remain null until each await
    // resolves; stopSession() uses cancelRequested to handle the race.
    const placeholder: ActiveSession = {
      agent: null,
      run: null,
      channelId,
      agentId: resumeAgentId,
      dbId,
      cancelRequested: false,
    };
    this.sessions.set(channelId, placeholder);

    // No systemPrompt API in Cursor SDK — prepend on fresh only; resume relies
    // on conversation history to retain the convention.
    const augmentedPrompt =
      !resumeAgentId && BOT_RULES
        ? `${BOT_RULES}\n\n---\n\n${prompt}`
        : prompt;

    // One attempt: build → send → stream → wait → result. `resumeFrom` lets
    // retry feed back placeholder.agentId after a first-attempt failure.
    const runAttempt = async (resumeFrom: string | null): Promise<void> => {
      // Cursor SDK local agents require an explicit model on every call —
      // resume() does not inherit the model from the persisted agent record.
      const modelSelection = {
        id: config.CURSOR_MODEL,
        ...(config.CURSOR_MODEL_PARAMS
          ? { params: config.CURSOR_MODEL_PARAMS }
          : {}),
      };
      const localOptions: LocalAgentOptions = {
        cwd: project.project_path,
        settingSources: ["all"],
      };

      let agent: SDKAgent;
      if (resumeFrom) {
        agent = await Agent.resume(resumeFrom, {
          apiKey: config.CURSOR_API_KEY,
          model: modelSelection,
          local: localOptions,
        });
      } else {
        agent = await Agent.create({
          apiKey: config.CURSOR_API_KEY,
          model: modelSelection,
          local: localOptions,
        });
      }

      placeholder.agent = agent;
      placeholder.agentId = agent.agentId;
      upsertSession(dbId, channelId, agent.agentId, "online");

      // If user pressed Stop during Agent.create/resume, bail before send.
      if (placeholder.cancelRequested) {
        await markDone();
        updateSessionStatus(channelId, "offline");
        return;
      }

      const run = await agent.send(augmentedPrompt);
      placeholder.run = run;

      // If user pressed Stop during agent.send, cancel immediately.
      if (placeholder.cancelRequested) {
        try {
          await run.cancel();
        } catch {
          // ignore
        }
        await markDone();
        updateSessionStatus(channelId, "offline");
        return;
      }

      for await (const event of run.stream()) {
        if (placeholder.cancelRequested) break;

        if (
          event.type === "system" &&
          event.subtype === "init" &&
          event.agent_id &&
          event.agent_id !== placeholder.agentId
        ) {
          // Defensive: if init reports a different agent_id than Agent.create
          // gave us, reconcile. In normal flow these match and we skip writes.
          placeholder.agentId = event.agent_id;
          upsertSession(dbId, channelId, event.agent_id, "online");
        }

        // Assistant text events stream incrementally — keep them in the
        // thread (progress view) only. The final embed will carry the full
        // text once via run.wait().result, so we don't edit it into the
        // main Discord message piece-by-piece.
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              threadReporter?.pushText(block.text);
            }
          }
        }

        if (event.type === "tool_call" && event.status === "running") {
          toolUseCount++;
          const input = (event.args ?? {}) as Record<string, unknown>;
          const detail = formatToolDetail(event.name, input);
          threadReporter?.pushTool(event.name, detail);

          const filePath = typeof input.file_path === "string"
            ? input.file_path
            : typeof input.path === "string"
            ? input.path
            : null;
          const fileSuffix = filePath ? ` \`${filePath.split(/[\\/]/).pop()}\`` : "";
          const label = TOOL_LABELS[event.name]?.() ?? `Using ${event.name}`;
          lastActivity = `${label}${fileSuffix}`;
          await renderStatus();
        }
      }

      const final = await run.wait();

      await markDone();

      if (final.status === "cancelled") {
        // /stop already updated the message + status to offline; skip the
        // success embed and don't overwrite the offline marker.
        return;
      }

      if (final.status === "error") {
        console.error(`[sendMessage] Cursor run errored for channel ${channelId}:`, {
          runId: final.id,
          result: final.result,
          durationMs: final.durationMs,
          model: final.model,
          git: final.git,
        });
        const errText = final.result || L("Run ended with an error", "런이 오류로 종료되었습니다");
        await channel.send(`❌ ${errText}`);
        updateSessionStatus(channelId, "offline");
        return;
      }

      const resultText = final.result || L("Task completed", "작업 완료");
      const { cleanText, attachmentPaths } = extractAttachments(resultText);

      if (attachmentPaths.length > 0) {
        await sendAttachments(
          channel,
          attachmentPaths,
          project.project_path,
        ).catch((e) => {
          console.warn(
            `[attach] sendAttachments failed for ${channelId}:`,
            e instanceof Error ? e.message : e,
          );
        });
      }

      const resultEmbed = createResultEmbed(
        cleanText,
        0,
        final.durationMs ?? Date.now() - startTime,
        config.SHOW_COST,
      );
      try {
        await channel.send({ embeds: [resultEmbed] });
      } catch (e) {
        console.warn(`[result] Failed to send result embed for ${channelId}:`, e instanceof Error ? e.message : e);
      }

      updateSessionStatus(channelId, "idle");
    };

    try {
      await runAttempt(resumeAgentId);
    } catch (error) {
      let finalError: unknown = error;
      // Skip retry once a Run is in flight — the server may have begun
      // executing tools, and re-sending the prompt could duplicate side effects.
      const canRetry = shouldRetryAuth(error, {
        cancelled: placeholder.cancelRequested,
        runStarted: placeholder.run !== null,
      });
      if (canRetry) {
        console.warn(
          `[self-heal] code-16 on attempt 1 for ${channelId}, agentId=${placeholder.agentId ?? "<none>"}, retrying in-process...`,
        );
        // Drop the broken handle synchronously — async dispose would route
        // through the same broken transport and may hang.
        try {
          placeholder.agent?.close();
        } catch {
          // ignore — handle already broken
        }
        placeholder.agent = null;
        placeholder.run = null;
        // Reset UI state so the next renderStatus() writes through; keep
        // currentMessage / heartbeat / threadReporter / startTime intact.
        toolUseCount = 0;
        lastStatusContent = "";
        lastActivity = L("Reconnecting...", "재연결 중...");
        try {
          await runAttempt(placeholder.agentId ?? resumeAgentId);
          console.info(`[self-heal] in-process retry succeeded for ${channelId}`);
          return;
        } catch (retryError) {
          console.error(
            `[self-heal] in-process retry also failed for ${channelId}, delegating to error handler:`,
            retryError instanceof Error ? retryError.message : retryError,
          );
          finalError = retryError;
        }
      }
      console.error(`[sendMessage] error for channel ${channelId}:`, finalError);
      if (isConnectError(finalError)) {
        console.error("[sendMessage] ConnectError detail:", {
          code: finalError.code,
          rawMessage: finalError.rawMessage,
        });
        if (finalError.code === Code.Unauthenticated) {
          maybeSelfRestart();
        }
      }
      const rawMsg = finalError instanceof Error ? finalError.message : "Unknown error occurred";
      const errMsg = parseApiError(rawMsg);
      const display = /^[❌⚠️]/u.test(errMsg) ? errMsg : `❌ ${errMsg}`;

      await Promise.all([markDone(), channel.send(display)]);
      updateSessionStatus(channelId, "offline");
    } finally {
      clearInterval(heartbeatInterval);
      await threadReporter?.stop();
      // Identity-check so a /stop + immediate new message doesn't have the
      // old run's finally tear down the new run's placeholder.
      if (this.sessions.get(channelId) === placeholder) {
        this.sessions.delete(channelId);
      }

      const queue = this.messageQueue.get(channelId);
      if (queue && queue.length > 0 && isRestartScheduled()) {
        // A code-16 self-restart is pending. The in-memory queue won't survive
        // the restart, and starting the next run now would just hit the same
        // broken connection. Drop the queue and tell the user to resend.
        this.messageQueue.delete(channelId);
        channel
          .send(
            L(
              "⚠️ Bot is restarting to recover the connection. Queued messages were cleared — please resend once it's back.",
              "⚠️ 연결 복구를 위해 봇을 재시작합니다. 대기 중이던 메시지가 초기화되었으니 복구 후 다시 보내주세요.",
            ),
          )
          .catch(() => {});
      } else if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.messageQueue.delete(channelId);
        const remaining = queue.length;
        const preview = next.prompt.length > 40 ? next.prompt.slice(0, 40) + "…" : next.prompt;
        const msg = remaining > 0
          ? L(`📨 Processing queued message... (remaining: ${remaining})\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다... (남은 큐: ${remaining}개)\n> ${preview}`)
          : L(`📨 Processing queued message...\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다...\n> ${preview}`);
        channel.send(msg).catch(() => {});
        this.sendMessage(next.channel, next.prompt).catch((err) => {
          console.error("Queue sendMessage error:", err);
          next.channel
            .send(
              L(
                "⚠️ Failed to process queued message. Please try again later.",
                "⚠️ 대기 중이던 메시지 처리에 실패했습니다. 잠시 후 다시 시도하세요.",
              ),
            )
            .catch(() => {});
        });
      }
    }
  }

  async stopSession(channelId: string): Promise<boolean> {
    const session = this.sessions.get(channelId);
    if (!session) return false;

    // Mark cancel for the startup race — sendMessage checks this flag after
    // each await so a Stop pressed before run is wired up still aborts.
    session.cancelRequested = true;

    if (session.run) {
      try {
        await session.run.cancel();
      } catch {
        // already stopped
      }
    }

    this.sessions.delete(channelId);
    updateSessionStatus(channelId, "offline");
    return true;
  }

  isActive(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  // --- Message queue ---

  setPendingQueue(channelId: string, channel: TextChannel, prompt: string): void {
    this.pendingQueuePrompts.set(channelId, { channel, prompt });
  }

  confirmQueue(channelId: string): boolean {
    const pending = this.pendingQueuePrompts.get(channelId);
    if (!pending) return false;
    this.pendingQueuePrompts.delete(channelId);
    const queue = this.messageQueue.get(channelId) ?? [];
    queue.push(pending);
    this.messageQueue.set(channelId, queue);
    return true;
  }

  cancelQueue(channelId: string): void {
    this.pendingQueuePrompts.delete(channelId);
  }

  isQueueFull(channelId: string): boolean {
    const queue = this.messageQueue.get(channelId) ?? [];
    return queue.length >= SessionManager.MAX_QUEUE_SIZE;
  }

  getQueueSize(channelId: string): number {
    return (this.messageQueue.get(channelId) ?? []).length;
  }

  hasQueue(channelId: string): boolean {
    return this.pendingQueuePrompts.has(channelId);
  }

  getQueue(channelId: string): { channel: TextChannel; prompt: string }[] {
    return this.messageQueue.get(channelId) ?? [];
  }

  clearQueue(channelId: string): number {
    const queue = this.messageQueue.get(channelId) ?? [];
    const count = queue.length;
    this.messageQueue.delete(channelId);
    this.pendingQueuePrompts.delete(channelId);
    return count;
  }

  removeFromQueue(channelId: string, index: number): string | null {
    const queue = this.messageQueue.get(channelId);
    if (!queue || index < 0 || index >= queue.length) return null;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.messageQueue.delete(channelId);
      this.pendingQueuePrompts.delete(channelId);
    }
    return removed.prompt;
  }
}

export const sessionManager = new SessionManager();

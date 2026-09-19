import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager as PiSessionManager,
  resolveCliModel,
  type AgentSession,
  type AgentSessionEvent,
  type ResolveCliModelResult,
} from "@earendil-works/pi-coding-agent";
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
import type { SessionStatus } from "../db/types.js";
import { getConfig } from "../utils/config.js";
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
    `[bot-rules] rules/BOT.md not found in candidates: ${candidates.join(", ")} — outbound [ATTACH:] convention will not be taught via system prompt.`,
  );
  return "";
})();

interface ActiveSession {
  session: AgentSession | null;
  channelId: string;
  sessionFile: string | null;
  dbId: string;
  cancelRequested: boolean;
}

// Thunks so L() reads .tray-lang at call time (live language switch).
const TOOL_LABELS: Record<string, () => string> = {
  read: () => L("Reading files", "파일 읽는 중"),
  bash: () => L("Running command", "명령어 실행 중"),
  edit: () => L("Editing file", "파일 편집 중"),
  write: () => L("Writing file", "파일 작성 중"),
  grep: () => L("Searching code", "코드 검색 중"),
  find: () => L("Searching files", "파일 검색 중"),
  ls: () => L("Listing files", "파일 목록 보기"),
  todo: () => L("Managing tasks", "작업 관리 중"),
  subagent: () => L("Spawning subagent", "서브에이전트 시작 중"),
  mcp: () => L("Calling MCP tool", "MCP 도구 호출 중"),
};

// Fallback detail for tools with unknown arg shapes (MCP/extension tools):
// first short string value, so the thread never shows a bare tool name.
function firstStringDetail(input: Record<string, unknown>): string {
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0 && v.length <= 120) return v;
  }
  return "";
}

export function formatToolDetail(_name: string, input: Record<string, unknown>): string {
  if (typeof input.command === "string") return `\`${input.command.slice(0, 100)}\``;
  if (typeof input.pattern === "string") {
    const pathSuffix = typeof input.path === "string" ? ` in \`${input.path}\`` : "";
    return `\`${input.pattern}\`${pathSuffix}`;
  }
  if (typeof input.path === "string") return `\`${input.path}\``;
  if (typeof input.query === "string") return `"${input.query.slice(0, 80)}"`;
  if (typeof input.subject === "string") {
    const action = typeof input.action === "string" ? `${input.action}: ` : "";
    return `${action}${input.subject}`.slice(0, 100);
  }
  if (typeof input.task === "string") return input.task.slice(0, 80);
  if (typeof input.url === "string") return `${input.url.slice(0, 120)}`;
  if (typeof input.description === "string") return `${input.description.slice(0, 80)}`;
  return firstStringDetail(input);
}

// --- Shared Pi runtime (process-wide) ---

let modelRuntime: ModelRuntime | null = null;
let botModelSpec: ResolveCliModelResult | null = null;
const loaderCache = new Map<string, DefaultResourceLoader>();

async function getModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntime) {
    // Default paths: ~/.pi/agent/auth.json + models.json. No env keys needed.
    modelRuntime = await ModelRuntime.create();
  }
  return modelRuntime;
}

export async function getBotModel(): Promise<NonNullable<ResolveCliModelResult["model"]>> {
  if (!botModelSpec) {
    const runtime = await getModelRuntime();
    const resolved = resolveCliModel({
      cliModel: getConfig().PI_MODEL,
      modelRuntime: runtime,
    });
    if (resolved.error || !resolved.model) {
      throw new Error(
        `Cannot resolve PI_MODEL "${getConfig().PI_MODEL}": ${resolved.error ?? "unknown model"}`,
      );
    }
    if (resolved.warning) console.warn(`[model] ${resolved.warning}`);
    botModelSpec = resolved;
  }
  return botModelSpec.model as NonNullable<ResolveCliModelResult["model"]>;
}

// Persona text for a channel's output style (rules/output-styles/<name>.md).
// Sanitized + fallback chain: requested -> seed -> empty (matches the
// pre-Cursor /output-styles behavior).
export function loadPersonaText(style: string | null | undefined): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const depths = [path.join(here, "..", ".."), path.join(here, "..")];
  const clean = (style || "seed").replace(/[^A-Za-z0-9_-]/g, "") || "seed";
  for (const name of [clean, "seed"]) {
    for (const base of depths) {
      try {
        const text = fs
          .readFileSync(path.join(base, "rules", "output-styles", `${name}.md`), "utf8")
          .trim();
        if (text) return text;
      } catch {
        // try next candidate
      }
    }
  }
  return "";
}

export async function getResourceLoader(
  cwd: string,
  style: string | null | undefined,
): Promise<DefaultResourceLoader> {
  const key = `${fs.realpathSync(cwd)}::${style ?? ""}`;
  const cached = loaderCache.get(key);
  if (cached) return cached;
  // Append (never replace): Pi's own system prompt + tool guidelines stay
  // intact; BOT.md + persona ride along after them.
  const extras = [BOT_RULES, loadPersonaText(style)].filter((s) => s.length > 0);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [...base, ...extras],
  });
  await loader.reload();
  loaderCache.set(key, loader);
  return loader;
}

export function getPiModelRuntime(): Promise<ModelRuntime> {
  return getModelRuntime();
}

// AgentMessage is not exported by the SDK, so walk message content structurally.
export function extractAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("\n");
    if (text.trim()) return text;
  }
  return "";
}

const MAX_RAW_ERROR_LEN = 200;
const ERROR_PREVIEW_LEN = 80;

export function parseApiError(rawMsg: string): string {
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
  // Terminal status writes go through here: a /stop + immediate new
  // message can start a replacement run while this run's tail is still
  // in flight, and an unguarded write would stomp the new run's status.
  private setStatusIfCurrent(ph: ActiveSession, status: SessionStatus): void {
    if (this.sessions.get(ph.channelId) === ph) {
      updateSessionStatus(ph.channelId, status);
    }
  }

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
    const resumeFile = existingSession?.sessionFile ?? dbSession?.pi_session_file ?? null;

    upsertSession(dbId, channelId, resumeFile, "online");

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

    // Reserve the channel slot BEFORE awaiting session creation so a second
    // message arriving in the same channel doesn't bypass isActive() and
    // start a parallel run. session remains null until createAgentSession
    // resolves; stopSession() uses cancelRequested to handle the race.
    const placeholder: ActiveSession = {
      session: null,
      channelId,
      sessionFile: resumeFile,
      dbId,
      cancelRequested: false,
    };
    this.sessions.set(channelId, placeholder);

    const runAttempt = async (): Promise<void> => {
      // realpath: SessionManager dirs are encoded per cwd, so a symlinked
      // path (e.g. macOS /tmp vs /private/tmp) would list/open the wrong
      // session bucket.
      const cwd = fs.realpathSync(project.project_path);
      const runtime = await getModelRuntime();
      const model = await getBotModel();
      const loader = await getResourceLoader(cwd, project.output_style);

      // No `tools` allowlist: the bot gets everything the loader discovers
      // (built-ins + extensions + MCP tools), same as the pi CLI.
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd,
        model,
        thinkingLevel: botModelSpec?.thinkingLevel,
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager: resumeFile
          ? PiSessionManager.open(resumeFile)
          : PiSessionManager.create(cwd),
      });
      if (modelFallbackMessage) {
        console.warn(`[session] model fallback for ${channelId}: ${modelFallbackMessage}`);
      }

      placeholder.session = session;

      // If user pressed Stop during session creation, bail BEFORE the
      // model pin and DB write — otherwise a stale "online" row lands
      // after stopSession() already marked the channel offline.
      if (placeholder.cancelRequested) {
        await markDone();
        this.setStatusIfCurrent(placeholder, "offline");
        return;
      }

      if (resumeFile) {
        // Pin the bot default model — the session file may record a
        // different model from a local pi CLI run. Predictable billing
        // over session fidelity.
        await session.setModel(model);
      }
      placeholder.sessionFile = session.sessionFile ?? null;
      upsertSession(dbId, channelId, placeholder.sessionFile, "online");

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (placeholder.cancelRequested) return;

        // Assistant text streams incrementally — keep it in the thread
        // (progress view) only. The final embed carries the full text once
        // from session.messages, so we don't edit it into the main
        // Discord message piece-by-piece.
        if (event.type === "message_update") {
          const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
            .assistantMessageEvent;
          if (inner?.type === "text_delta" && inner.delta) {
            threadReporter?.pushText(inner.delta);
          }
          return;
        }

        if (event.type === "tool_execution_start") {
          toolUseCount++;
          const ev = event as { toolName: string; args?: Record<string, unknown> };
          const input = (ev.args ?? {}) as Record<string, unknown>;
          const detail = formatToolDetail(ev.toolName, input);
          threadReporter?.pushTool(ev.toolName, detail);

          const filePath =
            typeof input.path === "string" ? input.path : null;
          const fileSuffix = filePath ? ` \`${filePath.split(/[\\/]/).pop()}\`` : "";
          const label = TOOL_LABELS[ev.toolName]?.() ?? `Using ${ev.toolName}`;
          lastActivity = `${label}${fileSuffix}`;
          void renderStatus();
        }
      });

      let costBefore: number | null = null;
      try {
        costBefore = session.getSessionStats().cost ?? 0;
      } catch {
        // Stats snapshot failed — report 0 below rather than risking the
        // whole session's cumulative cost masquerading as this run's.
        costBefore = null;
      }

      try {
        await session.prompt(prompt);
      } catch (e) {
        // session.abort() (via /stop) rejects the in-flight prompt —
        // that's the user-cancel path, not an error.
        if (!placeholder.cancelRequested) throw e;
      } finally {
        unsubscribe();
      }

      if (placeholder.cancelRequested) {
        await markDone();
        this.setStatusIfCurrent(placeholder, "offline");
        return;
      }

      await markDone();

      const resultText =
        extractAssistantText(session.messages) || L("Task completed", "작업 완료");
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

      // Per-run cost = session total delta across this prompt. The stats
      // API only exposes cumulative totals, so diff against the snapshot.
      let costUsd = 0;
      try {
        costUsd =
          costBefore === null
            ? 0
            : Math.max(0, (session.getSessionStats().cost ?? 0) - costBefore);
      } catch (e) {
        console.warn(`[stats] getSessionStats failed for ${channelId}:`, e instanceof Error ? e.message : e);
      }

      const resultEmbed = createResultEmbed(
        cleanText,
        costUsd,
        Date.now() - startTime,
        config.SHOW_COST,
      );
      try {
        await channel.send({ embeds: [resultEmbed] });
      } catch (e) {
        console.warn(`[result] Failed to send result embed for ${channelId}:`, e instanceof Error ? e.message : e);
      }

      this.setStatusIfCurrent(placeholder, "idle");
    };

    try {
      await runAttempt();
    } catch (error) {
      console.error(`[sendMessage] error for channel ${channelId}:`, error);
      const rawMsg = error instanceof Error ? error.message : "Unknown error occurred";
      const errMsg = parseApiError(rawMsg);
      const display = /^[❌⚠️]/u.test(errMsg) ? errMsg : `❌ ${errMsg}`;

      await Promise.all([markDone(), channel.send(display)]);
      this.setStatusIfCurrent(placeholder, "offline");
    } finally {
      clearInterval(heartbeatInterval);
      await threadReporter?.stop();
      try {
        placeholder.session?.dispose();
      } catch {
        // ignore — dispose is best-effort listener cleanup
      }
      // Identity-check so a /stop + immediate new message doesn't have the
      // old run's finally tear down the new run's placeholder.
      if (this.sessions.get(channelId) === placeholder) {
        this.sessions.delete(channelId);
      }

      const queue = this.messageQueue.get(channelId);
      if (queue && queue.length > 0) {
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
    // each await so a Stop pressed before the session is wired up still aborts.
    session.cancelRequested = true;

    if (session.session) {
      try {
        await session.session.abort();
      } catch {
        // already stopped
      }
    }

    // Identity guard (mirrors setStatusIfCurrent): while abort() was in
    // flight, the run's finally may have torn down this entry and started
    // a queued replacement run. Only delete + mark offline when the entry
    // is still the one we stopped — never a replacement run.
    if (this.sessions.get(channelId) === session) {
      this.sessions.delete(channelId);
      updateSessionStatus(channelId, "offline");
    }
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

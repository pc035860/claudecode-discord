import { Agent, type Run, type SDKAgent } from "@cursor/sdk";
import { randomUUID } from "node:crypto";
import type { TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
} from "../db/database.js";
import { getConfig } from "../utils/config.js";
import { L } from "../utils/i18n.js";
import { ThreadReporter } from "./thread-reporter.js";
import {
  createResultEmbed,
  createStopButton,
  createCompletedButton,
  splitMessage,
} from "./output-formatter.js";

interface ActiveSession {
  agent: SDKAgent;
  run: Run;
  channelId: string;
  agentId: string | null;
  dbId: string;
}

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

export function parseApiError(rawMsg: string): string {
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

    let responseBuffer = "";
    let lastEditTime = 0;
    const stopRow = createStopButton(channelId);
    let currentMessage = await channel.send({
      content: L("⏳ Thinking...", "⏳ 생각 중..."),
      components: [stopRow],
    });
    const EDIT_INTERVAL = 1500;

    async function flushBuffer(force = false): Promise<void> {
      if (responseBuffer.length === 0) return;
      if (!force) {
        const now = Date.now();
        if (now - lastEditTime < EDIT_INTERVAL) return;
      }

      const chunks = splitMessage(responseBuffer);
      try {
        await currentMessage.edit({ content: chunks[0] || "...", components: [] });
        for (let i = 1; i < chunks.length; i++) {
          currentMessage = await channel.send(chunks[i]);
        }
        responseBuffer = "";
      } catch (e) {
        console.warn(`[flush] Failed to edit message for ${channelId}, sending new:`, e instanceof Error ? e.message : e);
        for (const chunk of chunks) {
          currentMessage = await channel.send(chunk);
        }
        responseBuffer = "";
      }
      lastEditTime = Date.now();
    }

    const config = getConfig();
    let threadReporter: ThreadReporter | null = null;
    if (config.THREAD_PROGRESS) {
      threadReporter = new ThreadReporter(currentMessage);
      threadReporter.start();
    }

    const startTime = Date.now();
    let lastActivity = L("Thinking...", "생각 중...");
    let toolUseCount = 0;
    let hasTextOutput = false;
    let sessionDone = false;

    const heartbeatInterval = setInterval(async () => {
      if (hasTextOutput || sessionDone) return;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      try {
        await currentMessage.edit({
          content: `⏳ ${lastActivity} (${timeStr})`,
          components: [stopRow],
        });
        if (sessionDone) {
          await currentMessage.edit({ components: [createCompletedButton()] });
        }
      } catch (e) {
        console.warn(`[heartbeat] Failed to edit message for ${channelId}:`, e instanceof Error ? e.message : e);
      }
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

    try {
      let agent: SDKAgent;
      if (resumeAgentId) {
        agent = await Agent.resume(resumeAgentId, {
          apiKey: config.CURSOR_API_KEY,
          local: {
            cwd: project.project_path,
            settingSources: ["all"],
          },
        });
      } else {
        agent = await Agent.create({
          apiKey: config.CURSOR_API_KEY,
          model: {
            id: config.CURSOR_MODEL,
            ...(config.CURSOR_MODEL_PARAMS
              ? { params: config.CURSOR_MODEL_PARAMS }
              : {}),
          },
          local: {
            cwd: project.project_path,
            settingSources: ["all"],
          },
        });
      }

      upsertSession(dbId, channelId, agent.agentId, "online");

      const run = await agent.send(prompt);

      this.sessions.set(channelId, {
        agent,
        run,
        channelId,
        agentId: agent.agentId,
        dbId,
      });

      for await (const event of run.stream()) {
        if (event.type === "system" && event.subtype === "init" && event.agent_id) {
          const active = this.sessions.get(channelId);
          if (active) active.agentId = event.agent_id;
          upsertSession(dbId, channelId, event.agent_id, "online");
        }

        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              responseBuffer += block.text;
              hasTextOutput = true;
              threadReporter?.pushText(block.text);
            }
          }
          await flushBuffer();
        }

        if (event.type === "tool_call" && event.status === "running") {
          toolUseCount++;
          const input = (event.args ?? {}) as Record<string, unknown>;
          const detail = formatToolDetail(event.name, input);
          threadReporter?.pushTool(event.name, detail);

          const toolLabels: Record<string, string> = {
            read: L("Reading files", "파일 읽는 중"),
            ls: L("Listing files", "파일 목록 보기"),
            glob: L("Searching files", "파일 검색 중"),
            grep: L("Searching code", "코드 검색 중"),
            write: L("Writing file", "파일 작성 중"),
            edit: L("Editing file", "파일 편집 중"),
            shell: L("Running command", "명령어 실행 중"),
            semSearch: L("Semantic search", "의미 검색 중"),
            task: L("Spawning subagent", "서브에이전트 시작 중"),
            mcp: L("Calling MCP tool", "MCP 도구 호출 중"),
          };
          const filePath = typeof input.file_path === "string"
            ? input.file_path
            : typeof input.path === "string"
            ? input.path
            : null;
          const fileSuffix = filePath ? ` \`${filePath.split(/[\\/]/).pop()}\`` : "";
          lastActivity = `${toolLabels[event.name] ?? `Using ${event.name}`}${fileSuffix}`;

          if (!hasTextOutput) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const timeStr = elapsed > 60
              ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
              : `${elapsed}s`;
            try {
              await currentMessage.edit({
                content: `⏳ ${lastActivity} (${timeStr}) [${toolUseCount} tools used]`,
                components: [stopRow],
              });
            } catch (e) {
              console.warn(`[tool-status] Failed to edit message for ${channelId}:`, e instanceof Error ? e.message : e);
            }
          }
        }
      }

      await flushBuffer(true);
      const final = await run.wait();

      await markDone();
      const resultText = final.result || L("Task completed", "작업 완료");
      const resultEmbed = createResultEmbed(
        resultText,
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
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : "Unknown error occurred";
      const errMsg = parseApiError(rawMsg);

      await markDone();
      await channel.send(`❌ ${errMsg}`);
      updateSessionStatus(channelId, "offline");
    } finally {
      clearInterval(heartbeatInterval);
      await threadReporter?.stop();
      this.sessions.delete(channelId);

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
        });
      }
    }
  }

  async stopSession(channelId: string): Promise<boolean> {
    const session = this.sessions.get(channelId);
    if (!session) return false;

    try {
      await session.run.cancel();
    } catch {
      // already stopped
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

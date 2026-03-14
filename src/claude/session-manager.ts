import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
  setAutoApprove,
} from "../db/database.js";
import { getConfig } from "../utils/config.js";
import { L } from "../utils/i18n.js";
import { loadBotRules } from "../utils/rules-loader.js";
import { ThreadReporter } from "./thread-reporter.js";
import {
  createToolApprovalEmbed,
  createAskUserQuestionEmbed,
  createResultEmbed,
  createStopButton,
  createCompletedButton,
  splitMessage,
  extractAttachments,
  sendAttachments,
  type AskQuestionData,
} from "./output-formatter.js";

interface ActiveSession {
  queryInstance: Query;
  channelId: string;
  sessionId: string | null; // Claude Agent SDK session ID
  dbId: string;
}

// Pending approval requests: requestId -> resolve function
const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
    channelId: string;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

// Pending AskUserQuestion requests: requestId -> resolve function
const pendingQuestions = new Map<
  string,
  {
    resolve: (answer: string | null) => void;
    channelId: string;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

// Pending custom text inputs: channelId -> requestId
const pendingCustomInputs = new Map<string, { requestId: string }>();

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private static readonly MAX_QUEUE_SIZE = 5;
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string }[]>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string }>();

  async sendMessage(
    channel: TextChannel,
    prompt: string,
  ): Promise<void> {
    const channelId = channel.id;
    const project = getProject(channelId);
    if (!project) return;

    const existingSession = this.sessions.get(channelId);
    // If no in-memory session, check DB for previous session_id (for bot restart resume)
    const dbSession = !existingSession ? getSession(channelId) : undefined;
    const dbId = existingSession?.dbId ?? dbSession?.id ?? randomUUID();
    const resumeSessionId = existingSession?.sessionId ?? dbSession?.session_id ?? undefined;

    // Update status to online
    upsertSession(dbId, channelId, resumeSessionId ?? null, "online");

    // Streaming state
    let responseBuffer = "";
    let lastEditTime = 0;
    const pendingAttachments: string[] = [];
    const stopRow = createStopButton(channelId);
    let currentMessage = await channel.send({
      content: L("⏳ Thinking...", "⏳ 생각 중..."),
      components: [stopRow],
    });
    const EDIT_INTERVAL = 1500; // ms between edits (Discord rate limit friendly)

    async function flushBuffer(force = false): Promise<void> {
      if (responseBuffer.length === 0) return;
      if (!force) {
        const now = Date.now();
        if (now - lastEditTime < EDIT_INTERVAL) return;
      }

      const { cleanText, attachmentPaths } = extractAttachments(responseBuffer);
      pendingAttachments.push(...attachmentPaths);
      responseBuffer = cleanText;

      if (responseBuffer.length === 0) return;

      const chunks = splitMessage(responseBuffer);
      try {
        await currentMessage.edit({ content: chunks[0] || "...", components: [] });
        for (let i = 1; i < chunks.length; i++) {
          currentMessage = await channel.send(chunks[i]);
          responseBuffer = chunks.slice(i + 1).join("");
        }
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

    // Thread progress reporter
    let threadReporter: ThreadReporter | null = null;
    if (config.THREAD_PROGRESS) {
      threadReporter = new ThreadReporter(currentMessage);
      threadReporter.start();
    }

    // Activity tracking for progress display
    const startTime = Date.now();
    let lastActivity = L("Thinking...", "생각 중...");
    let toolUseCount = 0;
    let hasTextOutput = false;
    let sessionDone = false;

    const pendingToolBlocks = new Map<number, { name: string; inputJson: string }>();

    const formatToolDetail = (name: string, input: Record<string, unknown>): string => {
      if (name === "AskUserQuestion" && Array.isArray(input.questions)) {
        return (input.questions as { header: string }[]).map(q => q.header).join(", ");
      }
      if (name === "Agent" && typeof input.description === "string") {
        const type = typeof input.subagent_type === "string" ? `[${input.subagent_type}] ` : "";
        return `${type}${input.description.slice(0, 80)}`;
      }
      if (name === "TaskUpdate" && typeof input.id === "string") {
        const status = typeof input.status === "string" ? ` → ${input.status}` : "";
        return `#${input.id}${status}`;
      }
      if (name === "TaskOutput" && typeof input.id === "string") {
        return `#${input.id}`;
      }
      if (typeof input.file_path === "string") return `\`${input.file_path}\``;
      if (typeof input.command === "string") return `\`${input.command.slice(0, 100)}\``;
      if (typeof input.url === "string") return `${input.url.slice(0, 120)}`;
      if (typeof input.pattern === "string") return `\`${input.pattern}\`${typeof input.path === "string" ? ` in \`${input.path}\`` : ""}`;
      if (typeof input.query === "string") return `"${input.query.slice(0, 80)}"`;
      if (typeof input.skill === "string") return `${input.skill}`;
      if (typeof input.prompt === "string") return `"${input.prompt.slice(0, 80)}"`;
      if (typeof input.description === "string") return `${input.description.slice(0, 80)}`;
      return "";
    };

    // Heartbeat timer - updates status message every 15s when no text output yet
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

    const botRules = loadBotRules();

    try {
      const queryInstance = query({
        prompt,
        options: {
          cwd: project.project_path,
          env: {
            ...process.env,
            // Prevent "nested session" error when bot is started from inside Claude Code
            CLAUDECODE: undefined,
            ...(config.CLAUDE_CODE_AUTO_COMPACT_WINDOW
              ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.CLAUDE_CODE_AUTO_COMPACT_WINDOW) }
              : {}),
          },
          permissionMode: "default",
          model: config.CLAUDE_MODEL,
          effort: config.CLAUDE_EFFORT,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            ...(botRules ? { append: botRules } : {}),
          },
          settingSources: ["user", "project"],
          ...(config.THREAD_PROGRESS ? { includePartialMessages: true } : {}),
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),

          canUseTool: async (
            toolName: string,
            input: Record<string, unknown>,
          ) => {
            await flushBuffer(true);
            toolUseCount++;

            // Tool activity labels for Discord display
            const toolLabels: Record<string, string> = {
              Read: L("Reading files", "파일 읽는 중"),
              Glob: L("Searching files", "파일 검색 중"),
              Grep: L("Searching code", "코드 검색 중"),
              Write: L("Writing file", "파일 작성 중"),
              Edit: L("Editing file", "파일 편집 중"),
              Bash: L("Running command", "명령어 실행 중"),
              WebSearch: L("Searching web", "웹 검색 중"),
              WebFetch: L("Fetching URL", "URL 가져오는 중"),
              TodoWrite: L("Updating tasks", "작업 업데이트 중"),
            };
            const filePath = typeof input.file_path === "string"
              ? ` \`${(input.file_path as string).split(/[\\/]/).pop()}\``
              : "";
            lastActivity = `${toolLabels[toolName] ?? `Using ${toolName}`}${filePath}`;

            const toolDetail = formatToolDetail(toolName, input);

            // Update status message if no text output yet
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

            // Handle AskUserQuestion with interactive Discord UI
            if (toolName === "AskUserQuestion") {
              const questions = (input.questions as AskQuestionData[]) ?? [];
              if (questions.length === 0) {
                return { behavior: "allow" as const, updatedInput: input };
              }
              const answers: Record<string, string> = {};

              for (let qi = 0; qi < questions.length; qi++) {
                const q = questions[qi];
                const qRequestId = randomUUID();
                const { embed, components } = createAskUserQuestionEmbed(
                  q,
                  qRequestId,
                  qi,
                  questions.length,
                );

                updateSessionStatus(channelId, "waiting");
                await channel.send({ embeds: [embed], components });

                const answer = await new Promise<string | null>((resolve) => {
                  const timeout = setTimeout(() => {
                    pendingQuestions.delete(qRequestId);
                    // Clean up custom input if pending
                    const ci = pendingCustomInputs.get(channelId);
                    if (ci?.requestId === qRequestId) {
                      pendingCustomInputs.delete(channelId);
                    }
                    resolve(null);
                  }, 5 * 60 * 1000);

                  pendingQuestions.set(qRequestId, {
                    resolve: (ans) => {
                      clearTimeout(timeout);
                      pendingQuestions.delete(qRequestId);
                      resolve(ans);
                    },
                    channelId,
                    timeout,
                  });
                });

                if (answer === null) {
                  updateSessionStatus(channelId, "online");
                  return {
                    behavior: "deny" as const,
                    message: L("Question timed out", "질문 시간 초과"),
                  };
                }

                answers[q.header] = answer;
              }

              updateSessionStatus(channelId, "online");
              return {
                behavior: "allow" as const,
                updatedInput: { ...input, answers },
              };
            }

            // Auto-approve read-only tools
            const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
            if (readOnlyTools.includes(toolName)) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            // Check auto-approve setting
            const currentProject = getProject(channelId);
            if (currentProject?.auto_approve) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            // Ask user via Discord buttons
            const requestId = randomUUID();
            const { embed, row } = createToolApprovalEmbed(
              toolName,
              input,
              requestId,
            );

            updateSessionStatus(channelId, "waiting");
            await channel.send({
              embeds: [embed],
              components: [row],
            });

            // Wait for user decision (timeout 5 min)
            return new Promise((resolve) => {
              const timeout = setTimeout(() => {
                pendingApprovals.delete(requestId);
                updateSessionStatus(channelId, "online");
                threadReporter?.pushTool(toolName, `${toolDetail} ⏱️ timed out`);
                resolve({ behavior: "deny" as const, message: "Approval timed out" });
              }, 5 * 60 * 1000);

              pendingApprovals.set(requestId, {
                resolve: (decision) => {
                  clearTimeout(timeout);
                  pendingApprovals.delete(requestId);
                  updateSessionStatus(channelId, "online");
                  if (decision.behavior === "allow") {
                    resolve({ behavior: "allow" as const, updatedInput: input });
                  } else {
                    threadReporter?.pushTool(toolName, `${toolDetail} ❌ denied`);
                    resolve({ behavior: "deny" as const, message: decision.message ?? "Denied by user" });
                  }
                },
                channelId,
                timeout,
              });
            });
          },
        },
      });

      // Store the active session
      this.sessions.set(channelId, {
        queryInstance,
        channelId,
        sessionId: resumeSessionId ?? null,
        dbId,
      });

      for await (const message of queryInstance) {
        // Capture session ID
        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "init"
        ) {
          const sdkSessionId = (message as { session_id?: string }).session_id;
          if (sdkSessionId) {
            const active = this.sessions.get(channelId);
            if (active) active.sessionId = sdkSessionId;
            upsertSession(dbId, channelId, sdkSessionId, "online");
          }
        }

        // Handle stream events (text deltas + tool_use tracking for thread progress)
        if (message.type === "stream_event" && "event" in message) {
          const ev = (message as {
            event: {
              type: string;
              index?: number;
              content_block?: { type: string; name?: string };
              delta?: { type: string; text?: string; partial_json?: string };
            };
          }).event;

          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            threadReporter?.pushText(ev.delta.text);
          }

          if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && ev.content_block.name && ev.index != null) {
            pendingToolBlocks.set(ev.index, { name: ev.content_block.name, inputJson: "" });
          }

          if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && ev.delta.partial_json && ev.index != null) {
            const block = pendingToolBlocks.get(ev.index);
            if (block) block.inputJson += ev.delta.partial_json;
          }

          if (ev.type === "content_block_stop" && ev.index != null) {
            const block = pendingToolBlocks.get(ev.index);
            if (block) {
              pendingToolBlocks.delete(ev.index);
              let input: Record<string, unknown> = {};
              try { input = JSON.parse(block.inputJson || "{}"); } catch (e) {
                console.warn(`[stream-tool] Failed to parse tool input for ${block.name}:`, e instanceof Error ? e.message : e);
              }
              threadReporter?.pushTool(block.name, formatToolDetail(block.name, input));
            }
          }
        }

        // Handle streaming text
        if (message.type === "assistant" && "content" in message) {
          const content = message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if ("text" in block && typeof block.text === "string") {
                responseBuffer += block.text;
                hasTextOutput = true;
              }
            }
          }

          await flushBuffer();
        }

        // Handle result
        if ("result" in message) {
          const resultMsg = message as {
            result?: string;
            total_cost_usd?: number;
            duration_ms?: number;
          };

          await flushBuffer(true);

          // Extract attachments from result text and merge with pending
          const resultText = resultMsg.result ?? L("Task completed", "작업 완료");
          const { cleanText: cleanResult, attachmentPaths: resultAttachments } = extractAttachments(resultText);
          const allAttachments = [...pendingAttachments, ...resultAttachments];
          await sendAttachments(channel, allAttachments, project.project_path);

          await markDone();
          const resultEmbed = createResultEmbed(
            cleanResult || L("Task completed", "작업 완료"),
            resultMsg.total_cost_usd ?? 0,
            resultMsg.duration_ms ?? 0,
            config.SHOW_COST,
          );
          try {
            await channel.send({ embeds: [resultEmbed] });
          } catch (e) {
            console.warn(`[result] Failed to send result embed for ${channelId}:`, e instanceof Error ? e.message : e);
          }

          updateSessionStatus(channelId, "idle");
        }
      }
    } catch (error) {
      const rawMsg =
        error instanceof Error ? error.message : "Unknown error occurred";

      // Parse API error JSON to show clean message
      let errMsg = rawMsg;
      const jsonMatch = rawMsg.match(
        /API Error: (\d+)\s*(\{.*\})/s,
      );
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[2]);
          const statusCode = jsonMatch[1];
          const message =
            parsed?.error?.message ?? parsed?.message ?? "Unknown error";
          errMsg = `API Error ${statusCode}: ${message}. Please try again later.`;
        } catch (parseErr) {
          console.warn(`[error-parse] Failed to parse API error JSON for ${channelId}:`, parseErr instanceof Error ? parseErr.message : parseErr);
          // Fall back to extracting just the status code
          errMsg = `API Error ${jsonMatch[1]}. Please try again later.`;
        }
      } else if (rawMsg.includes("process exited with code")) {
        errMsg = `${rawMsg}. The server may be temporarily unavailable — please try again later.`;
      }

      await markDone();
      await channel.send(`❌ ${errMsg}`);
      updateSessionStatus(channelId, "offline");
    } finally {
      clearInterval(heartbeatInterval);
      await threadReporter?.stop();
      this.sessions.delete(channelId);

      // Clean up any pending approvals/questions for this channel
      for (const [id, entry] of pendingApprovals) {
        if (entry.channelId === channelId) {
          clearTimeout(entry.timeout);
          pendingApprovals.delete(id);
        }
      }
      for (const [id, entry] of pendingQuestions) {
        if (entry.channelId === channelId) {
          clearTimeout(entry.timeout);
          pendingQuestions.delete(id);
        }
      }
      pendingCustomInputs.delete(channelId);
      pendingToolBlocks.clear();

      // Process next queued message if any
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
      await session.queryInstance.interrupt();
    } catch {
      // already stopped
    }

    this.sessions.delete(channelId);

    // Clean up any pending approvals/questions for this channel
    for (const [id, entry] of pendingApprovals) {
      if (entry.channelId === channelId) {
        clearTimeout(entry.timeout);
        pendingApprovals.delete(id);
      }
    }
    for (const [id, entry] of pendingQuestions) {
      if (entry.channelId === channelId) {
        clearTimeout(entry.timeout);
        pendingQuestions.delete(id);
      }
    }
    pendingCustomInputs.delete(channelId);

    updateSessionStatus(channelId, "offline");
    return true;
  }

  isActive(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  resolveApproval(
    requestId: string,
    decision: "approve" | "deny" | "approve-all",
  ): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;

    if (decision === "approve-all") {
      // Enable auto-approve for this channel
      setAutoApprove(pending.channelId, true);
      pending.resolve({ behavior: "allow" });
    } else if (decision === "approve") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by user" });
    }

    return true;
  }

  resolveQuestion(requestId: string, answer: string): boolean {
    const pending = pendingQuestions.get(requestId);
    if (!pending) return false;
    pending.resolve(answer);
    return true;
  }

  enableCustomInput(requestId: string, channelId: string): void {
    pendingCustomInputs.set(channelId, { requestId });
  }

  resolveCustomInput(channelId: string, text: string): boolean {
    const ci = pendingCustomInputs.get(channelId);
    if (!ci) return false;
    pendingCustomInputs.delete(channelId);

    const pending = pendingQuestions.get(ci.requestId);
    if (!pending) return false;
    pending.resolve(text);
    return true;
  }

  hasPendingCustomInput(channelId: string): boolean {
    return pendingCustomInputs.has(channelId);
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

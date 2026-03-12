import type { ThreadChannel, Message } from "discord.js";
import { MAX_DISCORD_LENGTH } from "./output-formatter.js";

const FLUSH_INTERVAL = 5_000;
const MAX_TEXT_PREVIEW = 120;

type ProgressEvent =
  | { type: "tool"; name: string; detail: string }
  | { type: "text"; content: string };

export class ThreadReporter {
  private thread: ThreadChannel | null = null;
  private buffer: ProgressEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private anchorMessage: Message) {}

  async start(): Promise<void> {
    try {
      this.thread = await this.anchorMessage.startThread({
        name: "Progress",
        autoArchiveDuration: 60,
      });
    } catch (e) {
      console.warn("[thread-reporter] Failed to create thread:", e instanceof Error ? e.message : e);
      return;
    }

    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);
  }

  pushTool(name: string, detail: string): void {
    if (!this.thread) return;
    this.buffer.push({ type: "tool", name, detail });
  }

  pushText(content: string): void {
    if (!this.thread) return;
    this.buffer.push({ type: "text", content });
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.thread || this.buffer.length === 0) return;
    this.flushing = true;

    try {
      const events = this.buffer.splice(0);
      const lines: string[] = [];

      for (const ev of events) {
        if (ev.type === "tool") {
          lines.push(`🔧 **${ev.name}** ${ev.detail}`);
        } else {
          const preview = ev.content.length > MAX_TEXT_PREVIEW
            ? ev.content.slice(0, MAX_TEXT_PREVIEW) + "…"
            : ev.content;
          const oneLine = preview.replace(/\n/g, " ").trim();
          if (oneLine) {
            lines.push(`💬 ${oneLine}`);
          }
        }
      }

      if (lines.length === 0) return;

      let msg = lines.join("\n");
      if (msg.length > MAX_DISCORD_LENGTH) {
        msg = msg.slice(0, MAX_DISCORD_LENGTH) + "\n…";
      }

      await this.thread.send({ content: msg, allowedMentions: { parse: [] } });
    } catch (e) {
      console.warn("[thread-reporter] Failed to send to thread:", e instanceof Error ? e.message : e);
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flush();
    } catch (e) {
      console.warn("[thread-reporter] Error in stop:", e instanceof Error ? e.message : e);
    }
  }
}

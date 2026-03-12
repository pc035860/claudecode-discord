import type { ThreadChannel, Message } from "discord.js";
import { MAX_DISCORD_LENGTH } from "./output-formatter.js";

const FLUSH_INTERVAL = 5_000;
const MAX_TEXT_PREVIEW = 200;

type ProgressEvent =
  | { type: "tool"; name: string; detail: string }
  | { type: "text"; content: string };

export class ThreadReporter {
  private thread: ThreadChannel | null = null;
  private buffer: ProgressEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> | null = null;

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

  private async doFlush(): Promise<void> {
    if (!this.thread || this.buffer.length === 0) return;

    const events = this.buffer.splice(0);
    const lines: string[] = [];

    let textAccum = "";
    const flushText = () => {
      if (!textAccum) return;
      const preview = textAccum.length > MAX_TEXT_PREVIEW
        ? textAccum.slice(0, MAX_TEXT_PREVIEW) + "…"
        : textAccum;
      const oneLine = preview.replace(/\n/g, " ").trim();
      if (oneLine) {
        lines.push(`💬 ${oneLine}`);
      }
      textAccum = "";
    };

    for (const ev of events) {
      if (ev.type === "tool") {
        flushText();
        lines.push(`🔧 **${ev.name}** ${ev.detail}`);
      } else {
        textAccum += ev.content;
      }
    }
    flushText();

    if (lines.length === 0) return;

    let msg = lines.join("\n");
    if (msg.length > MAX_DISCORD_LENGTH) {
      msg = msg.slice(0, MAX_DISCORD_LENGTH) + "\n…";
    }

    await this.thread.send({ content: msg, allowedMentions: { parse: [] } });
  }

  async flush(): Promise<void> {
    if (this.flushPromise) return;
    try {
      this.flushPromise = this.doFlush();
      await this.flushPromise;
    } catch (e) {
      console.warn("[thread-reporter] Failed to send to thread:", e instanceof Error ? e.message : e);
    } finally {
      this.flushPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      if (this.flushPromise) {
        await this.flushPromise;
      }
      await this.doFlush();
    } catch (e) {
      console.warn("[thread-reporter] Error in stop:", e instanceof Error ? e.message : e);
    }
  }
}

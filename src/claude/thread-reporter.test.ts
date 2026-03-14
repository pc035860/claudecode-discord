import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ThreadReporter } from "./thread-reporter.js";
import { MAX_DISCORD_LENGTH } from "./output-formatter.js";

vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

function mockAnchorMessage() {
  const threadSend = vi.fn().mockResolvedValue(undefined);
  const thread = { send: threadSend } as any;
  const startThread = vi.fn().mockResolvedValue(thread);
  const message = { startThread } as any;
  return { message, thread, threadSend, startThread };
}

describe("ThreadReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("lifecycle", () => {
    it("pushTool ignored before start", () => {
      const { message, startThread } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.pushTool("Read", "file.ts");
      reporter.pushText("hello");
      // Force flush — nothing should happen
      reporter.flush();
      expect(startThread).not.toHaveBeenCalled();
    });

    it("pushTool works after start", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "`file.ts`");
      await reporter.flush();
      expect(threadSend).toHaveBeenCalledTimes(1);
      const content = threadSend.mock.calls[0][0].content;
      expect(content).toContain("🔧 **Read** `file.ts`");
      await reporter.stop();
    });

    it("pushTool ignored after stop", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      await reporter.stop();
      reporter.pushTool("Read", "file.ts");
      await reporter.flush();
      expect(threadSend).not.toHaveBeenCalled();
    });
  });

  describe("flush formatting", () => {
    it("formats tool event as bold name with detail", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Bash", "`ls -la`");
      await reporter.flush();
      expect(threadSend.mock.calls[0][0].content).toBe("🔧 **Bash** `ls -la`");
      await reporter.stop();
    });

    it("merges consecutive text events into single line", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushText("hello ");
      reporter.pushText("world");
      await reporter.flush();
      expect(threadSend.mock.calls[0][0].content).toBe("💬 hello world");
      await reporter.stop();
    });

    it("truncates text over 200 chars", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushText("x".repeat(300));
      await reporter.flush();
      const content = threadSend.mock.calls[0][0].content;
      expect(content).toContain("…");
      expect(content.length).toBeLessThan(220);
      await reporter.stop();
    });

    it("replaces newlines with spaces in text", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushText("line1\nline2\nline3");
      await reporter.flush();
      expect(threadSend.mock.calls[0][0].content).toBe("💬 line1 line2 line3");
      await reporter.stop();
    });

    it("whitespace-only text produces no send", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushText("\n\n\n");
      await reporter.flush();
      expect(threadSend).not.toHaveBeenCalled();
      await reporter.stop();
    });

    it("interleaves tool and text events correctly", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushText("analyzing");
      reporter.pushTool("Read", "`src/index.ts`");
      reporter.pushText("done");
      await reporter.flush();
      const lines = threadSend.mock.calls[0][0].content.split("\n");
      expect(lines[0]).toBe("💬 analyzing");
      expect(lines[1]).toBe("🔧 **Read** `src/index.ts`");
      expect(lines[2]).toBe("💬 done");
      await reporter.stop();
    });

    it("truncates message over MAX_DISCORD_LENGTH", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      for (let i = 0; i < 200; i++) {
        reporter.pushTool(`Tool${i}`, "x".repeat(20));
      }
      await reporter.flush();
      const content = threadSend.mock.calls[0][0].content;
      expect(content.length).toBeLessThanOrEqual(MAX_DISCORD_LENGTH + 5);
      expect(content).toContain("…");
      await reporter.stop();
    });

    it("sends with allowedMentions parse empty", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "file");
      await reporter.flush();
      expect(threadSend.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
      await reporter.stop();
    });

    it("empty buffer does not create thread", async () => {
      const { message, startThread } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      await reporter.flush();
      expect(startThread).not.toHaveBeenCalled();
      await reporter.stop();
    });
  });

  describe("lazy thread creation", () => {
    it("creates thread on first flush with content", async () => {
      const { message, startThread } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "file");
      await reporter.flush();
      expect(startThread).toHaveBeenCalledWith({
        name: "Progress",
        autoArchiveDuration: 60,
      });
      await reporter.stop();
    });

    it("reuses thread on subsequent flushes", async () => {
      const { message, startThread } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "a");
      await reporter.flush();
      reporter.pushTool("Write", "b");
      await reporter.flush();
      expect(startThread).toHaveBeenCalledTimes(1);
      await reporter.stop();
    });

    it("deactivates on startThread failure", async () => {
      const { message, startThread, threadSend } = mockAnchorMessage();
      startThread.mockRejectedValueOnce(new Error("Cannot create thread"));
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "file");
      await reporter.flush();

      reporter.pushTool("Write", "file2");
      await reporter.flush();
      expect(threadSend).not.toHaveBeenCalled();
      await reporter.stop();
    });
  });

  describe("concurrent flush guard", () => {
    it("skips second flush while first is in progress", async () => {
      let resolveFirst!: () => void;
      const deferred = new Promise<void>((r) => { resolveFirst = r; });
      const { message, threadSend } = mockAnchorMessage();
      threadSend.mockImplementationOnce(() => deferred);

      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "a");
      const first = reporter.flush();

      // Yield to let async chain reach threadSend
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      reporter.pushTool("Write", "b");
      const second = reporter.flush();

      resolveFirst();
      await first;
      await second;

      expect(threadSend).toHaveBeenCalledTimes(1);
      await reporter.stop();
    });
  });

  describe("stop", () => {
    it("clears timer and does final flush", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "a");
      await reporter.stop();
      expect(threadSend).toHaveBeenCalledTimes(1);
    });

    it("drains buffer after stop", async () => {
      const { message, threadSend } = mockAnchorMessage();
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "a");
      reporter.pushTool("Write", "b");
      reporter.pushText("hello");
      await reporter.stop();
      expect(threadSend).toHaveBeenCalledTimes(1);
      const content = threadSend.mock.calls[0][0].content;
      expect(content).toContain("Read");
      expect(content).toContain("Write");
      expect(content).toContain("hello");
    });

    it("handles error during final flush gracefully", async () => {
      const { message, threadSend } = mockAnchorMessage();
      threadSend.mockRejectedValueOnce(new Error("send failed"));
      const reporter = new ThreadReporter(message);
      reporter.start();
      reporter.pushTool("Read", "a");
      await reporter.stop();

      reporter.pushTool("Write", "b");
      await reporter.flush();
      expect(threadSend).toHaveBeenCalledTimes(1);
    });
  });
});

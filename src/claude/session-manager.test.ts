import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("../db/database.js", () => ({
  upsertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getProject: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => ({
    SHOW_COST: true,
    PI_MODEL: "openrouter/meta/muse-spark-1.3-contributor:medium",
    THREAD_PROGRESS: false,
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  getAgentDir: vi.fn(() => "/tmp/agent-dir"),
  DefaultResourceLoader: vi.fn(function (this: unknown) {
    return { reload: vi.fn().mockResolvedValue(undefined) };
  }),
  ModelRuntime: { create: vi.fn() },
  SessionManager: { open: vi.fn(), create: vi.fn() },
  resolveCliModel: vi.fn(),
}));

vi.mock("./output-formatter.js", () => ({
  createResultEmbed: vi.fn(() => ({})),
  createStopButton: vi.fn(() => ({})),
  createCompletedButton: vi.fn(() => ({})),
  extractAttachments: vi.fn((text: string) => ({ cleanText: text, attachmentPaths: [] })),
  sendAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./thread-reporter.js", () => ({
  ThreadReporter: vi.fn(function (this: unknown) {
    return { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), pushText: vi.fn(), pushTool: vi.fn() };
  }),
}));

import {
  sessionManager,
  formatToolDetail,
  parseApiError,
  extractAssistantText,
} from "./session-manager.js";

function mockChannel(id: string) {
  return { id, send: vi.fn().mockResolvedValue({ edit: vi.fn() }) } as any;
}

function mockPiSession(overrides: Record<string, any> = {}) {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(() => vi.fn()),
    setModel: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
    sessionFile: "/sessions/test.jsonl",
    sessionId: "sess-1",
    getSessionStats: vi.fn(() => ({ cost: 0.0123, tokens: { total: 100 } })),
    ...overrides,
  };
}

async function setupPiMocks(sessionOverrides: Record<string, any> = {}) {
  const pi = await import("@earendil-works/pi-coding-agent");
  const session = mockPiSession(sessionOverrides);
  (pi.ModelRuntime.create as any).mockResolvedValue({});
  (pi.resolveCliModel as any).mockReturnValue({
    model: { id: "meta/muse-spark-1.3-contributor" },
    thinkingLevel: "medium",
    warning: undefined,
    error: undefined,
  });
  (pi.SessionManager.create as any).mockReturnValue({});
  (pi.SessionManager.open as any).mockReturnValue({});
  (pi.createAgentSession as any).mockResolvedValue({ session, modelFallbackMessage: undefined });
  return { pi, session };
}

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isActive", () => {
    it("returns false for unknown channel", () => {
      expect(sessionManager.isActive("unknown-channel")).toBe(false);
    });
  });

  describe("message queue", () => {
    const channelId = "queue-ch";

    afterEach(() => {
      sessionManager.clearQueue(channelId);
      sessionManager.cancelQueue(channelId);
    });

    it("hasQueue returns false initially", () => {
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("getQueueSize returns 0 initially", () => {
      expect(sessionManager.getQueueSize(channelId)).toBe(0);
    });

    it("isQueueFull returns false when empty", () => {
      expect(sessionManager.isQueueFull(channelId)).toBe(false);
    });

    it("setPendingQueue + hasQueue works", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "test prompt");
      expect(sessionManager.hasQueue(channelId)).toBe(true);
    });

    it("confirmQueue moves pending to queue", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "prompt 1");
      const result = sessionManager.confirmQueue(channelId);
      expect(result).toBe(true);
      expect(sessionManager.getQueueSize(channelId)).toBe(1);
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("confirmQueue returns false when nothing pending", () => {
      expect(sessionManager.confirmQueue("no-pending")).toBe(false);
    });

    it("cancelQueue clears pending", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "to cancel");
      sessionManager.cancelQueue(channelId);
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("isQueueFull returns true after 5 items", () => {
      const ch = "full-queue-ch";
      const channel = mockChannel(ch);
      for (let i = 0; i < 5; i++) {
        sessionManager.setPendingQueue(ch, channel, `msg ${i}`);
        sessionManager.confirmQueue(ch);
      }
      expect(sessionManager.isQueueFull(ch)).toBe(true);
      expect(sessionManager.getQueueSize(ch)).toBe(5);
      sessionManager.clearQueue(ch);
    });
  });

  describe("stopSession", () => {
    it("returns false for inactive session", async () => {
      expect(await sessionManager.stopSession("no-session")).toBe(false);
    });
  });
});

describe("sendMessage (Pi engine)", () => {
  const channelId = "pi-send-ch";

  beforeEach(async () => {
    vi.clearAllMocks();
    const db = await import("../db/database.js");
    (db.getProject as any).mockReturnValue({
      id: "p1",
      channel_id: channelId,
      project_path: "/tmp",
    });
    (db.getSession as any).mockReturnValue(undefined);
  });

  afterEach(async () => {
    if (sessionManager.isActive(channelId)) {
      await sessionManager.stopSession(channelId);
    }
  });

  it("creates a fresh session when no resume file, prompts, and sends result embed with real cost", async () => {
    const { pi, session } = await setupPiMocks();
    // Stats are cumulative: snapshot 0 before the run, 0.0123 after.
    session.getSessionStats
      .mockReturnValueOnce({ cost: 0, tokens: { total: 10 } })
      .mockReturnValue({ cost: 0.0123, tokens: { total: 100 } });
    const channel = mockChannel(channelId);
    await sessionManager.sendMessage(channel, "hello");

    expect(pi.SessionManager.create).toHaveBeenCalled();
    expect(pi.SessionManager.open).not.toHaveBeenCalled();
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledWith("hello");

    const formatter = await import("./output-formatter.js");
    expect(formatter.createResultEmbed).toHaveBeenCalledWith(
      "done",
      0.0123,
      expect.any(Number),
      true,
    );

    const db = await import("../db/database.js");
    expect(db.updateSessionStatus).toHaveBeenCalledWith(channelId, "idle");
    expect(session.dispose).toHaveBeenCalled();
  });

  it("resumes from DB session file and pins the bot model", async () => {
    const db = await import("../db/database.js");
    (db.getSession as any).mockReturnValue({
      id: "db-1",
      pi_session_file: "/sessions/old.jsonl",
    });
    const { pi, session } = await setupPiMocks();
    const channel = mockChannel(channelId);
    await sessionManager.sendMessage(channel, "hello");

    expect(pi.SessionManager.open).toHaveBeenCalledWith("/sessions/old.jsonl");
    expect(session.setModel).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledWith("hello");
  });

  it("sends ❌ and marks offline when prompt() throws", async () => {
    await setupPiMocks({ prompt: vi.fn().mockRejectedValue(new Error("provider boom")) });
    const channel = mockChannel(channelId);
    await sessionManager.sendMessage(channel, "hello");

    const sent = (channel.send as any).mock.calls.map((c: any[]) => c[0]);
    const errs = sent.filter(
      (m: any) => typeof m === "string" && m.startsWith("❌"),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("provider boom");

    const db = await import("../db/database.js");
    expect(db.updateSessionStatus).toHaveBeenCalledWith(channelId, "offline");
  });

  it("treats abort during prompt as user stop: no embed, stays offline", async () => {
    const { session } = await setupPiMocks({
      prompt: vi.fn(
        () => new Promise((_, rej) => setTimeout(() => rej(new Error("aborted")), 30)),
      ),
    });
    const channel = mockChannel(channelId);
    const flight = sessionManager.sendMessage(channel, "hello");
    await new Promise((r) => setTimeout(r, 5));
    const stopped = await sessionManager.stopSession(channelId);
    expect(stopped).toBe(true);
    expect(session.abort).toHaveBeenCalled();
    await flight;

    const formatter = await import("./output-formatter.js");
    expect(formatter.createResultEmbed).not.toHaveBeenCalled();

    const db = await import("../db/database.js");
    expect(db.updateSessionStatus).toHaveBeenCalledWith(channelId, "offline");
  });
});

describe("formatToolDetail (Pi tools)", () => {
  it("returns backtick-wrapped command for bash", () => {
    expect(formatToolDetail("bash", { command: "ls -la" })).toBe("`ls -la`");
  });

  it("truncates command at 100 chars", () => {
    const long = "x".repeat(150);
    expect(formatToolDetail("bash", { command: long })).toBe(
      "`" + "x".repeat(100) + "`",
    );
  });

  it("returns backtick-wrapped path for read/write/edit/ls", () => {
    expect(formatToolDetail("read", { path: "/a/b.ts" })).toBe("`/a/b.ts`");
    expect(formatToolDetail("write", { path: "/a/b.ts" })).toBe("`/a/b.ts`");
    expect(formatToolDetail("edit", { path: "/a/b.ts" })).toBe("`/a/b.ts`");
    expect(formatToolDetail("ls", { path: "/src" })).toBe("`/src`");
  });

  it("returns pattern with path for grep/find", () => {
    expect(formatToolDetail("grep", { pattern: "foo", path: "/src" })).toBe(
      "`foo` in `/src`",
    );
    expect(formatToolDetail("find", { pattern: "**/*.ts" })).toBe("`**/*.ts`");
  });

  it("returns url truncated at 120 chars", () => {
    const long = "https://" + "x".repeat(150);
    const result = formatToolDetail("custom", { url: long });
    expect(result.length).toBe(120);
  });

  it("returns empty string for empty input", () => {
    expect(formatToolDetail("unknown", {})).toBe("");
  });

  it("command takes priority over generic description", () => {
    expect(
      formatToolDetail("bash", { command: "ls", description: "list files" }),
    ).toBe("`ls`");
  });
});

describe("extractAssistantText", () => {
  it("returns the last assistant text message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ];
    expect(extractAssistantText(messages)).toBe("second");
  });

  it("skips thinking-only assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "..." }],
      },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];
    expect(extractAssistantText(messages)).toBe("answer");
  });

  it("returns empty string when no assistant text exists", () => {
    expect(extractAssistantText([])).toBe("");
    expect(
      extractAssistantText([{ role: "user", content: "hi" }]),
    ).toBe("");
  });
});

describe("parseApiError", () => {
  it("returns raw message for unknown errors", () => {
    expect(parseApiError("Something broke")).toBe("Something broke");
  });

  it("trims long multi-line unknown errors to short summary", () => {
    const input = [
      "TypeError: something blew up",
      "    at frame1 (/foo.js:1:1)",
      "    at frame2 (/foo.js:2:2)",
      "    at frame3 (/foo.js:3:3)",
      "    at frame4 (/foo.js:4:4)",
      "    at frame5 (/foo.js:5:5)",
    ].join("\n");
    const result = parseApiError(input);
    expect(result.toLowerCase()).toContain("unexpected internal error");
    expect(result).toContain("TypeError: something blew up");
    expect(result).not.toContain("frame3");
  });
});

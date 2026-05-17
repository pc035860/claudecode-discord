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
    CURSOR_API_KEY: "test-key",
    CURSOR_MODEL: "composer-2",
    CURSOR_MODEL_PARAMS: undefined,
    THREAD_PROGRESS: false,
  })),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
    list: vi.fn(),
  },
}));

import { sessionManager, formatToolDetail, parseApiError } from "./session-manager.js";

function mockChannel(id: string) {
  return { id, send: vi.fn().mockResolvedValue({ edit: vi.fn() }) } as any;
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

describe("formatToolDetail (Cursor tools)", () => {
  it("returns [type] description for task with subagent_type", () => {
    expect(
      formatToolDetail("task", {
        description: "explore code",
        subagent_type: "researcher",
      }),
    ).toBe("[researcher] explore code");
  });

  it("returns description for task without subagent_type", () => {
    expect(formatToolDetail("task", { description: "explore code" })).toBe(
      "explore code",
    );
  });

  it("truncates task description at 80 chars", () => {
    const long = "x".repeat(100);
    expect(formatToolDetail("task", { description: long })).toBe("x".repeat(80));
  });

  it("returns backtick-wrapped command for shell tool", () => {
    expect(formatToolDetail("shell", { command: "ls -la" })).toBe("`ls -la`");
  });

  it("truncates command at 100 chars", () => {
    const long = "x".repeat(150);
    expect(formatToolDetail("shell", { command: long })).toBe(
      "`" + "x".repeat(100) + "`",
    );
  });

  it("returns backtick-wrapped file_path for read/write/edit", () => {
    expect(formatToolDetail("read", { file_path: "/a/b.ts" })).toBe("`/a/b.ts`");
    expect(formatToolDetail("write", { file_path: "/a/b.ts" })).toBe("`/a/b.ts`");
    expect(formatToolDetail("edit", { file_path: "/a/b.ts" })).toBe("`/a/b.ts`");
  });

  it("returns backtick-wrapped path for ls", () => {
    expect(formatToolDetail("ls", { path: "/src" })).toBe("`/src`");
  });

  it("returns pattern with path for grep", () => {
    expect(formatToolDetail("grep", { pattern: "*.ts", path: "/src" })).toBe(
      "`*.ts` in `/src`",
    );
  });

  it("returns pattern alone for glob", () => {
    expect(formatToolDetail("glob", { pattern: "**/*.ts" })).toBe("`**/*.ts`");
  });

  it("returns quoted query for semSearch", () => {
    expect(formatToolDetail("semSearch", { query: "auth flow" })).toBe(
      '"auth flow"',
    );
  });

  it("returns url truncated at 120 chars", () => {
    const long = "https://" + "x".repeat(150);
    const result = formatToolDetail("mcp", { url: long });
    expect(result.length).toBe(120);
  });

  it("returns empty string for empty input", () => {
    expect(formatToolDetail("unknown", {})).toBe("");
  });

  it("command takes priority over generic description", () => {
    expect(
      formatToolDetail("shell", { command: "ls", description: "list files" }),
    ).toBe("`ls`");
  });
});

describe("parseApiError", () => {
  it("extracts error.message from API error JSON", () => {
    const input = 'API Error: 429 {"error":{"message":"rate limited"}}';
    expect(parseApiError(input)).toBe(
      "API Error 429: rate limited. Please try again later.",
    );
  });

  it("extracts top-level message from API error JSON", () => {
    const input = 'API Error: 500 {"message":"internal"}';
    expect(parseApiError(input)).toBe(
      "API Error 500: internal. Please try again later.",
    );
  });

  it("falls back to status code for unparseable JSON", () => {
    const input = "API Error: 502 {bad json}";
    expect(parseApiError(input)).toBe("API Error 502. Please try again later.");
  });

  it("appends retry suggestion for process exit errors", () => {
    const input = "process exited with code 1";
    expect(parseApiError(input)).toContain("temporarily unavailable");
  });

  it("returns raw message for unknown errors", () => {
    expect(parseApiError("Something broke")).toBe("Something broke");
  });

  it("handles multiline JSON body (dotall flag)", () => {
    const input = 'API Error: 429\n{"error":{"message":"wait"}}';
    expect(parseApiError(input)).toBe(
      "API Error 429: wait. Please try again later.",
    );
  });
});

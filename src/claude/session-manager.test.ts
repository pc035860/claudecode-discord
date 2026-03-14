import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies before importing session-manager
vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("../db/database.js", () => ({
  upsertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getProject: vi.fn(),
  getSession: vi.fn(),
  setAutoApprove: vi.fn(),
}));

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => ({ SHOW_COST: true })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { sessionManager, formatToolDetail, parseApiError } from "./session-manager.js";

// Helper to create a mock TextChannel
function mockChannel(id: string) {
  return { id, send: vi.fn().mockResolvedValue({ edit: vi.fn() }) } as any;
}

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── isActive ───

  describe("isActive", () => {
    it("returns false for unknown channel", () => {
      expect(sessionManager.isActive("unknown-channel")).toBe(false);
    });
  });

  // ─── resolveApproval ───

  describe("resolveApproval", () => {
    it("returns false for unknown requestId", () => {
      expect(sessionManager.resolveApproval("nonexistent", "approve")).toBe(false);
    });
  });

  // ─── resolveQuestion ───

  describe("resolveQuestion", () => {
    it("returns false for unknown requestId", () => {
      expect(sessionManager.resolveQuestion("nonexistent", "answer")).toBe(false);
    });
  });

  // ─── Custom input ───

  describe("custom input", () => {
    it("hasPendingCustomInput returns false initially", () => {
      expect(sessionManager.hasPendingCustomInput("ch-1")).toBe(false);
    });

    it("enableCustomInput sets pending state", () => {
      sessionManager.enableCustomInput("req-1", "ch-1");
      expect(sessionManager.hasPendingCustomInput("ch-1")).toBe(true);
    });

    it("resolveCustomInput returns false when no pending question", () => {
      sessionManager.enableCustomInput("req-no-question", "ch-2");
      // There's a custom input pending but no matching question in pendingQuestions
      expect(sessionManager.resolveCustomInput("ch-2", "hello")).toBe(false);
    });

    it("resolveCustomInput returns false for channel without pending input", () => {
      expect(sessionManager.resolveCustomInput("ch-no-input", "hello")).toBe(false);
    });
  });

  // ─── Message queue ───

  describe("message queue", () => {
    const channelId = "queue-ch";

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
    });
  });

  // ─── stopSession ───

  describe("stopSession", () => {
    it("returns false for inactive session", async () => {
      expect(await sessionManager.stopSession("no-session")).toBe(false);
    });
  });
});

// ─── formatToolDetail ───

describe("formatToolDetail", () => {
  it("returns question headers for AskUserQuestion", () => {
    expect(formatToolDetail("AskUserQuestion", {
      questions: [{ header: "Auth" }, { header: "DB" }],
    })).toBe("Auth, DB");
  });

  it("returns [type] description for Agent with subagent_type", () => {
    expect(formatToolDetail("Agent", {
      description: "explore code",
      subagent_type: "researcher",
    })).toBe("[researcher] explore code");
  });

  it("returns description for Agent without subagent_type", () => {
    expect(formatToolDetail("Agent", {
      description: "explore code",
    })).toBe("explore code");
  });

  it("truncates Agent description at 80 chars", () => {
    const long = "x".repeat(100);
    const result = formatToolDetail("Agent", { description: long });
    expect(result).toBe("x".repeat(80));
  });

  it("returns #id → status for TaskUpdate", () => {
    expect(formatToolDetail("TaskUpdate", { id: "t1", status: "done" })).toBe("#t1 → done");
  });

  it("returns #id for TaskUpdate without status", () => {
    expect(formatToolDetail("TaskUpdate", { id: "t1" })).toBe("#t1");
  });

  it("returns #id for TaskOutput", () => {
    expect(formatToolDetail("TaskOutput", { id: "t2" })).toBe("#t2");
  });

  it("returns backtick-wrapped file_path", () => {
    expect(formatToolDetail("Read", { file_path: "/a/b.ts" })).toBe("`/a/b.ts`");
  });

  it("returns backtick-wrapped command truncated at 100", () => {
    const long = "x".repeat(150);
    const result = formatToolDetail("Bash", { command: long });
    expect(result).toBe("`" + "x".repeat(100) + "`");
  });

  it("returns url truncated at 120", () => {
    const long = "https://" + "x".repeat(150);
    const result = formatToolDetail("WebFetch", { url: long });
    expect(result.length).toBe(120);
  });

  it("returns pattern with path", () => {
    expect(formatToolDetail("Grep", { pattern: "*.ts", path: "/src" })).toBe('`*.ts` in `/src`');
  });

  it("returns pattern without path", () => {
    expect(formatToolDetail("Grep", { pattern: "*.ts" })).toBe("`*.ts`");
  });

  it("returns quoted query", () => {
    expect(formatToolDetail("WebSearch", { query: "search term" })).toBe('"search term"');
  });

  it("returns skill name", () => {
    expect(formatToolDetail("Skill", { skill: "coding" })).toBe("coding");
  });

  it("returns quoted prompt", () => {
    expect(formatToolDetail("SomeTool", { prompt: "build feature" })).toBe('"build feature"');
  });

  it("returns generic description (non-Agent)", () => {
    expect(formatToolDetail("SomeTool", { description: "do stuff" })).toBe("do stuff");
  });

  it("returns empty string for empty input", () => {
    expect(formatToolDetail("Unknown", {})).toBe("");
  });

  it("file_path takes priority over command", () => {
    expect(formatToolDetail("Tool", { file_path: "/a.ts", command: "ls" })).toBe("`/a.ts`");
  });
});

// ─── parseApiError ───

describe("parseApiError", () => {
  it("extracts error.message from API error JSON", () => {
    const input = 'API Error: 429 {"error":{"message":"rate limited"}}';
    expect(parseApiError(input)).toBe("API Error 429: rate limited. Please try again later.");
  });

  it("extracts top-level message from API error JSON", () => {
    const input = 'API Error: 500 {"message":"internal"}';
    expect(parseApiError(input)).toBe("API Error 500: internal. Please try again later.");
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
    expect(parseApiError(input)).toBe("API Error 429: wait. Please try again later.");
  });
});

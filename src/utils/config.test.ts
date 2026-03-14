import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function expectConfigExit() {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  const { loadConfig } = await import("./config.js");
  expect(() => loadConfig()).toThrow("process.exit called");
  expect(exitSpy).toHaveBeenCalledWith(1);
  exitSpy.mockRestore();
}

describe("config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.DISCORD_BOT_TOKEN = "test-token";
    process.env.DISCORD_GUILD_ID = "test-guild";
    process.env.ALLOWED_USER_IDS = "user1,user2";
    process.env.BASE_PROJECT_DIR = "/projects";
    delete process.env.RATE_LIMIT_PER_MINUTE;
    delete process.env.SHOW_COST;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_EFFORT;
    delete process.env.THREAD_PROGRESS;
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("loadConfig returns valid config from environment", async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.DISCORD_BOT_TOKEN).toBe("test-token");
    expect(config.DISCORD_GUILD_ID).toBe("test-guild");
    expect(config.ALLOWED_USER_IDS).toEqual(["user1", "user2"]);
    expect(config.BASE_PROJECT_DIR).toBe("/projects");
  });

  it("uses default values for optional fields", async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(config.SHOW_COST).toBe(true);
    expect(config.CLAUDE_MODEL).toBe("claude-sonnet-4-6");
    expect(config.CLAUDE_EFFORT).toBe("medium");
    expect(config.THREAD_PROGRESS).toBe(false);
    expect(config.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });

  it("parses ALLOWED_USER_IDS with spaces", async () => {
    process.env.ALLOWED_USER_IDS = " user1 , user2 , user3 ";
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.ALLOWED_USER_IDS).toEqual(["user1", "user2", "user3"]);
  });

  it("coerces RATE_LIMIT_PER_MINUTE to integer", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "20";
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(20);
  });

  it("parses SHOW_COST as boolean", async () => {
    process.env.SHOW_COST = "false";
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.SHOW_COST).toBe(false);
  });

  it("calls process.exit(1) when required env vars are missing", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    await expectConfigExit();
  });

  it("getConfig returns cached config on second call", async () => {
    const { loadConfig, getConfig } = await import("./config.js");
    const first = loadConfig();
    const second = getConfig();
    expect(first).toBe(second);
  });

  it("getConfig calls loadConfig if not yet loaded", async () => {
    const { getConfig } = await import("./config.js");
    const config = getConfig();
    expect(config.DISCORD_BOT_TOKEN).toBe("test-token");
  });

  describe("CLAUDE_MODEL", () => {
    it("accepts custom model value", async () => {
      process.env.CLAUDE_MODEL = "claude-opus-4-6";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CLAUDE_MODEL).toBe("claude-opus-4-6");
    });
  });

  describe("CLAUDE_EFFORT", () => {
    it("parses 'high' correctly", async () => {
      process.env.CLAUDE_EFFORT = "high";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CLAUDE_EFFORT).toBe("high");
    });

    it("parses 'low' correctly", async () => {
      process.env.CLAUDE_EFFORT = "low";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CLAUDE_EFFORT).toBe("low");
    });

    it("rejects invalid effort value", async () => {
      process.env.CLAUDE_EFFORT = "ultra";
      await expectConfigExit();
    });
  });

  describe("THREAD_PROGRESS", () => {
    it("parses 'true' as boolean true", async () => {
      process.env.THREAD_PROGRESS = "true";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().THREAD_PROGRESS).toBe(true);
    });

    it("parses 'false' as boolean false", async () => {
      process.env.THREAD_PROGRESS = "false";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().THREAD_PROGRESS).toBe(false);
    });

    it("rejects invalid value", async () => {
      process.env.THREAD_PROGRESS = "yes";
      await expectConfigExit();
    });
  });

  describe("CLAUDE_CODE_AUTO_COMPACT_WINDOW", () => {
    it("returns undefined when not set", async () => {
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    });

    it("returns undefined for empty string", async () => {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", async () => {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "  ";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    });

    it("parses valid positive integer", async () => {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "100";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(100);
    });

    // Number("1e2") === 100 and Number.isInteger(100) === true
    it("parses scientific notation as integer", async () => {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1e2";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(100);
    });

    it("rejects zero", async () => {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "0";
      await expectConfigExit();
    });

    it("rejects negative number", async () => {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "-1";
      await expectConfigExit();
    });

    it("rejects decimal number", async () => {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "3.5";
      await expectConfigExit();
    });

    it("rejects non-numeric string", async () => {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "abc";
      await expectConfigExit();
    });
  });
});

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
    process.env.CURSOR_API_KEY = "test-cursor-key";
    delete process.env.RATE_LIMIT_PER_MINUTE;
    delete process.env.SHOW_COST;
    delete process.env.CURSOR_MODEL;
    delete process.env.CURSOR_MODEL_PARAMS;
    delete process.env.THREAD_PROGRESS;
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
    expect(config.CURSOR_API_KEY).toBe("test-cursor-key");
  });

  it("uses default values for optional fields", async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(config.SHOW_COST).toBe(true);
    expect(config.CURSOR_MODEL).toBe("composer-2-fast");
    expect(config.CURSOR_MODEL_PARAMS).toBeUndefined();
    expect(config.THREAD_PROGRESS).toBe(false);
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

  it("calls process.exit(1) when CURSOR_API_KEY missing", async () => {
    delete process.env.CURSOR_API_KEY;
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

  describe("CURSOR_MODEL", () => {
    it("accepts custom model value", async () => {
      process.env.CURSOR_MODEL = "claude-opus-4-7";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CURSOR_MODEL).toBe("claude-opus-4-7");
    });
  });

  describe("CURSOR_MODEL_PARAMS", () => {
    it("returns undefined when not set", async () => {
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CURSOR_MODEL_PARAMS).toBeUndefined();
    });

    it("returns undefined for empty string", async () => {
      process.env.CURSOR_MODEL_PARAMS = "";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CURSOR_MODEL_PARAMS).toBeUndefined();
    });

    it("parses JSON array of {id,value} objects", async () => {
      process.env.CURSOR_MODEL_PARAMS =
        '[{"id":"thinking","value":"high"},{"id":"fast","value":"on"}]';
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().CURSOR_MODEL_PARAMS).toEqual([
        { id: "thinking", value: "high" },
        { id: "fast", value: "on" },
      ]);
    });

    it("rejects non-JSON string", async () => {
      process.env.CURSOR_MODEL_PARAMS = "thinking-high";
      await expectConfigExit();
    });

    it("rejects JSON object (not array)", async () => {
      process.env.CURSOR_MODEL_PARAMS = '{"x":1}';
      await expectConfigExit();
    });

    it("rejects array with bare strings", async () => {
      process.env.CURSOR_MODEL_PARAMS = '["thinking-high"]';
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
});

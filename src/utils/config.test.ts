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
    delete process.env.PI_MODEL;
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
  });

  it("uses default values for optional fields", async () => {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(config.SHOW_COST).toBe(true);
    expect(config.PI_MODEL).toBe(
      "accounts/fireworks/models/deepseek-v4p1-flash:medium",
    );
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

  describe("PI_MODEL", () => {
    it("accepts custom model spec value", async () => {
      process.env.PI_MODEL = "anthropic/claude-opus-4-5:high";
      const { loadConfig } = await import("./config.js");
      expect(loadConfig().PI_MODEL).toBe("anthropic/claude-opus-4-5:high");
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

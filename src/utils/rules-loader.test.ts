import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadBotRules } from "./rules-loader.js";

describe("loadBotRules", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-loader-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns content when file exists", () => {
    fs.writeFileSync(path.join(tmpDir, "bot-rules.md"), "## Rules\n- Be concise");
    expect(loadBotRules("bot-rules.md", tmpDir)).toBe("## Rules\n- Be concise");
  });

  it("returns undefined when file does not exist", () => {
    expect(loadBotRules("bot-rules.md", tmpDir)).toBeUndefined();
  });

  it("returns undefined when file is empty", () => {
    fs.writeFileSync(path.join(tmpDir, "bot-rules.md"), "");
    expect(loadBotRules("bot-rules.md", tmpDir)).toBeUndefined();
  });

  it("returns undefined when file contains only whitespace", () => {
    fs.writeFileSync(path.join(tmpDir, "bot-rules.md"), "  \n\t  ");
    expect(loadBotRules("bot-rules.md", tmpDir)).toBeUndefined();
  });

  it("trims leading and trailing whitespace from content", () => {
    fs.writeFileSync(path.join(tmpDir, "bot-rules.md"), "\n## Rules\n");
    expect(loadBotRules("bot-rules.md", tmpDir)).toBe("## Rules");
  });
});

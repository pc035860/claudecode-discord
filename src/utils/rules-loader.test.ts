import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadBotRules, listOutputStyles } from "./rules-loader.js";

describe("loadBotRules", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-loader-test-"));
    fs.mkdirSync(path.join(tmpDir, "rules", "output-styles"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns BOT.md content when no style file exists", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "BOT.md"), "## Rules\n- Be concise");
    expect(loadBotRules(undefined, tmpDir)).toBe("## Rules\n- Be concise");
  });

  it("returns undefined when neither BOT.md nor style file exists", () => {
    expect(loadBotRules(undefined, tmpDir)).toBeUndefined();
  });

  it("returns undefined when BOT.md is empty and no style file", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "BOT.md"), "");
    expect(loadBotRules(undefined, tmpDir)).toBeUndefined();
  });

  it("returns undefined when BOT.md is whitespace only and no style file", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "BOT.md"), "  \n\t  ");
    expect(loadBotRules(undefined, tmpDir)).toBeUndefined();
  });

  it("trims leading and trailing whitespace from BOT.md content", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "BOT.md"), "\n## Rules\n");
    expect(loadBotRules(undefined, tmpDir)).toBe("## Rules");
  });

  it("combines BOT.md and style file content", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "BOT.md"), "## Bot Rules");
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "seed.md"), "## Style");
    expect(loadBotRules("seed", tmpDir)).toBe("## Bot Rules\n\n## Style");
  });

  it("returns only style content when BOT.md does not exist", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "seed.md"), "## Style");
    expect(loadBotRules("seed", tmpDir)).toBe("## Style");
  });

  it("falls back to seed style when outputStyle is undefined", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "seed.md"), "## Cide");
    expect(loadBotRules(undefined, tmpDir)).toBe("## Cide");
  });

  it("falls back to seed when specified style file does not exist", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "seed.md"), "## Seed");
    expect(loadBotRules("missing-style", tmpDir)).toBe("## Seed");
  });

  it("rejects path traversal style names and falls back to seed", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "seed.md"), "## Seed");
    expect(loadBotRules("../../etc/passwd", tmpDir)).toBe("## Seed");
    expect(loadBotRules("../BOT", tmpDir)).toBe("## Seed");
  });
});

describe("listOutputStyles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-loader-test-"));
    fs.mkdirSync(path.join(tmpDir, "rules", "output-styles"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns style names without extension", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "seed.md"), "");
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "neutral.md"), "");
    expect(listOutputStyles(tmpDir).sort()).toEqual(["neutral", "seed"]);
  });

  it("returns empty array when directory does not exist", () => {
    fs.rmdirSync(path.join(tmpDir, "rules", "output-styles"));
    expect(listOutputStyles(tmpDir)).toEqual([]);
  });

  it("ignores non-.md files", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "seed.md"), "");
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "readme.txt"), "");
    expect(listOutputStyles(tmpDir)).toEqual(["seed"]);
  });

  it("filters out style names that do not match [A-Za-z0-9_-]", () => {
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "seed.md"), "");
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "foo.bar.md"), "");
    fs.writeFileSync(path.join(tmpDir, "rules", "output-styles", "中文.md"), "");
    expect(listOutputStyles(tmpDir)).toEqual(["seed"]);
  });
});

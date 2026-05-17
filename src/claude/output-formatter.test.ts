import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

import {
  splitMessage,
  createResultEmbed,
  createStopButton,
  createCompletedButton,
} from "./output-formatter.js";

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("returns single chunk at exactly 1900 characters", () => {
    const text = "a".repeat(1900);
    expect(splitMessage(text)).toEqual([text]);
  });

  it("splits long messages at newline boundaries", () => {
    const line1 = "a".repeat(1000);
    const line2 = "b".repeat(1000);
    const text = line1 + "\n" + line2;
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toContain("b");
  });

  it("splits at MAX_DISCORD_LENGTH when no suitable newline found", () => {
    const text = "a".repeat(3800);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toHaveLength(1900);
  });

  it("preserves code block fences across splits (with language)", () => {
    const code = "x".repeat(1850);
    const text = "```typescript\n" + code + "\n" + "y".repeat(500) + "\n```";
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toMatch(/```$/);
    expect(chunks[1]).toMatch(/^```typescript\n/);
  });

  it("preserves code block fences without language specifier", () => {
    const code = "x".repeat(1850);
    const text = "```\n" + code + "\n" + "y".repeat(500) + "\n```";
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toMatch(/```$/);
    expect(chunks[1]).toMatch(/^```\n/);
  });

  it("handles closed code block before split point", () => {
    const block = "```js\nconsole.log('hello');\n```\n";
    const after = "a".repeat(1900);
    const text = block + after;
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const fenceCount = (chunks[0].match(/^```/gm) || []).length;
    expect(fenceCount % 2).toBe(0);
  });

  it("handles empty string", () => {
    expect(splitMessage("")).toEqual([]);
  });

  it("handles very long single line", () => {
    const text = "a".repeat(6000);
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1920);
    }
  });

  it("prefers splitting at newline near the end rather than mid-line", () => {
    const text = "a".repeat(1500) + "\n" + "b".repeat(800);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(1500));
  });
});

describe("createResultEmbed", () => {
  it("shows cost in footer when showCost is true", () => {
    const embed = createResultEmbed("Done", 0.0123, 5000, true);
    const footer = embed.data.footer?.text ?? "";
    expect(footer).toContain("Cost");
    expect(footer).toContain("$0.0123");
    expect(footer).toContain("Duration");
    expect(footer).toContain("5.0s");
  });

  it("hides cost in footer when showCost is false", () => {
    const embed = createResultEmbed("Done", 0.0123, 5000, false);
    const footer = embed.data.footer?.text ?? "";
    expect(footer).not.toContain("Cost");
    expect(footer).toContain("Duration : 5.0s");
  });

  it("formats duration correctly", () => {
    const embed = createResultEmbed("Done", 0, 12500, true);
    const footer = embed.data.footer?.text ?? "";
    expect(footer).toContain("12.5s");
  });

  it("truncates very long result text to 4000 chars", () => {
    const embed = createResultEmbed("x".repeat(5000), 0, 0);
    expect(embed.data.description!.length).toBeLessThanOrEqual(4000);
  });
});

describe("createStopButton", () => {
  it("creates button with correct customId", () => {
    const row = createStopButton("ch-123");
    expect(row.components[0].data).toHaveProperty("custom_id", "stop:ch-123");
  });
});

describe("createCompletedButton", () => {
  it("creates disabled button", () => {
    const row = createCompletedButton();
    expect(row.components[0].data).toHaveProperty("disabled", true);
  });
});

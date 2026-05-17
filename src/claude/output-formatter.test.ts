import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

import {
  splitMessage,
  createResultEmbed,
  createStopButton,
  createCompletedButton,
  extractAttachments,
  sendAttachments,
} from "./output-formatter.js";
import fs from "node:fs";

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

describe("extractAttachments", () => {
  it("extracts single attachment marker", () => {
    const { cleanText, attachmentPaths } = extractAttachments(
      "Here is the file [ATTACH: /tmp/image.png] done",
    );
    expect(attachmentPaths).toEqual(["/tmp/image.png"]);
    expect(cleanText).toBe("Here is the file done");
  });

  it("extracts multiple attachment markers", () => {
    const { cleanText, attachmentPaths } = extractAttachments(
      "[ATTACH: /tmp/a.png] text [ATTACH: /tmp/b.jpg]",
    );
    expect(attachmentPaths).toEqual(["/tmp/a.png", "/tmp/b.jpg"]);
    expect(cleanText).toBe("text");
  });

  it("removes entire bullet line when marker is the only content", () => {
    const { cleanText, attachmentPaths } = extractAttachments(
      "results:\n- [ATTACH: /tmp/output.csv]\ndone",
    );
    expect(attachmentPaths).toEqual(["/tmp/output.csv"]);
    expect(cleanText).not.toContain("-");
    expect(cleanText).toBe("results:\n\ndone");
  });

  it("does not leave double spaces after removal", () => {
    const { cleanText } = extractAttachments(
      "before [ATTACH: /tmp/x.png] after",
    );
    expect(cleanText).not.toContain("  ");
    expect(cleanText).toBe("before after");
  });

  it("returns empty array when no markers present", () => {
    const { cleanText, attachmentPaths } = extractAttachments("just text");
    expect(attachmentPaths).toEqual([]);
    expect(cleanText).toBe("just text");
  });

  it("handles empty string", () => {
    const { cleanText, attachmentPaths } = extractAttachments("");
    expect(attachmentPaths).toEqual([]);
    expect(cleanText).toBe("");
  });

  it("handles marker-only text (result is empty)", () => {
    const { cleanText, attachmentPaths } = extractAttachments(
      "[ATTACH: /tmp/only.png]",
    );
    expect(attachmentPaths).toEqual(["/tmp/only.png"]);
    expect(cleanText).toBe("");
  });

  it("trims whitespace around paths", () => {
    const { attachmentPaths } = extractAttachments(
      "[ATTACH:   /tmp/spaced.png  ]",
    );
    expect(attachmentPaths).toEqual(["/tmp/spaced.png"]);
  });

  it("handles paths with spaces", () => {
    const { attachmentPaths } = extractAttachments(
      "[ATTACH: /tmp/my file.png]",
    );
    expect(attachmentPaths).toEqual(["/tmp/my file.png"]);
  });
});

describe("sendAttachments", () => {
  let channel: { send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    channel = { send: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(fs, "realpathSync").mockImplementation((p) => String(p));
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing for empty array", async () => {
    await sendAttachments(channel, []);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("uploads file in /tmp", async () => {
    await sendAttachments(channel, ["/tmp/file.png"]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    const call = channel.send.mock.calls[0][0];
    expect(call.files).toHaveLength(1);
  });

  it("uploads file in /private/tmp (macOS)", async () => {
    await sendAttachments(channel, ["/private/tmp/file.png"]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    const call = channel.send.mock.calls[0][0];
    expect(call.files).toHaveLength(1);
  });

  it("uploads file within projectPath", async () => {
    await sendAttachments(
      channel,
      ["/projects/myapp/output.png"],
      "/projects/myapp",
    );
    expect(channel.send).toHaveBeenCalledTimes(1);
    const call = channel.send.mock.calls[0][0];
    expect(call.files).toHaveLength(1);
  });

  it("blocks file outside allowed paths", async () => {
    await sendAttachments(channel, ["/etc/passwd"]);
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining("blocked"),
    );
    const filesCall = channel.send.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "object" && (c[0] as { files?: unknown }).files,
    );
    expect(filesCall).toBeUndefined();
  });

  it("blocks symlink escape (realpathSync resolves outside)", async () => {
    vi.mocked(fs.realpathSync).mockImplementation((p) => {
      if (String(p) === "/tmp/evil-link") return "/etc/secrets";
      return String(p);
    });
    await sendAttachments(channel, ["/tmp/evil-link"]);
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining("blocked"),
    );
  });

  it("falls back to path.resolve when realpathSync throws", async () => {
    vi.mocked(fs.realpathSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    await sendAttachments(channel, ["/tmp/newfile.png"]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    const call = channel.send.mock.calls[0][0];
    expect(call.files).toHaveLength(1);
  });

  it("warns when file does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await sendAttachments(channel, ["/tmp/missing.png"]);
    expect(channel.send).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
  });

  it("deduplicates paths", async () => {
    await sendAttachments(channel, [
      "/tmp/a.png",
      "/tmp/a.png",
      "/tmp/a.png",
    ]);
    const filesCall = channel.send.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "object" && (c[0] as { files?: unknown }).files,
    );
    expect((filesCall![0] as { files: unknown[] }).files).toHaveLength(1);
  });

  it("caps at 10 attachments", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/tmp/file${i}.png`);
    await sendAttachments(channel, paths);
    const filesCall = channel.send.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "object" && (c[0] as { files?: unknown }).files,
    );
    expect((filesCall![0] as { files: unknown[] }).files).toHaveLength(10);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Too many"),
    );
  });

  it("sends warning when channel.send with files throws", async () => {
    channel.send
      .mockRejectedValueOnce(new Error("Discord API error"))
      .mockResolvedValueOnce(undefined);
    await sendAttachments(channel, ["/tmp/file.png"]);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send).toHaveBeenLastCalledWith(
      expect.stringContaining("Failed to send"),
    );
  });
});

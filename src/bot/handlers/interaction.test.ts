import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  findChannelsBySessionFile: vi.fn(() => []),
}));

vi.mock("../../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("../../security/guard.js", () => ({
  isAllowedUser: vi.fn(() => true),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { list: vi.fn() },
}));

vi.mock("../../claude/session-manager.js", () => ({
  sessionManager: { isActive: vi.fn(() => false) },
}));

import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import {
  findChannelsBySessionFile,
  getProject,
} from "../../db/database.js";
import { handleSelectMenuInteraction } from "./interaction.js";

function mockDeleteSelect(channelId: string, value: string) {
  return {
    channelId,
    customId: "session-delete-select",
    values: [value],
    user: { id: "allowed-user" },
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function mockListedFile(filePath: string) {
  vi.mocked(PiSessionManager.list).mockResolvedValue([
    {
      path: filePath,
      id: "sess-x",
      cwd: "/tmp",
      created: new Date(),
      modified: new Date(),
      messageCount: 2,
      firstMessage: "hi",
      allMessagesText: "hi",
    },
  ]);
}

describe("session-delete-select", () => {
  const project = {
    channel_id: "ch-1",
    project_path: "/tmp",
    guild_id: "g-1",
    output_style: "seed",
    created_at: "",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProject).mockReturnValue(project);
    vi.mocked(findChannelsBySessionFile).mockReturnValue([]);
  });

  it("deletes an unlinked session that is in the fresh listing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delsess-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, "{}\n");
    mockListedFile(file);
    const interaction = mockDeleteSelect("ch-1", file);
    await handleSelectMenuInteraction(interaction);
    expect(fs.existsSync(file)).toBe(false);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Deleted"),
      }),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a session linked to the current channel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delsess-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, "{}\n");
    mockListedFile(file);
    vi.mocked(findChannelsBySessionFile).mockReturnValue(["ch-1"]);
    const interaction = mockDeleteSelect("ch-1", file);
    await handleSelectMenuInteraction(interaction);
    expect(fs.existsSync(file)).toBe(true);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("current channel"),
      }),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a session linked to another channel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delsess-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, "{}\n");
    mockListedFile(file);
    vi.mocked(findChannelsBySessionFile).mockReturnValue(["ch-2"]);
    const interaction = mockDeleteSelect("ch-1", file);
    await handleSelectMenuInteraction(interaction);
    expect(fs.existsSync(file)).toBe(true);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("another channel"),
      }),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports missing file when the value no longer exists", async () => {
    vi.mocked(PiSessionManager.list).mockResolvedValue([]);
    const interaction = mockDeleteSelect("ch-1", "/nonexistent/gone.jsonl");
    await handleSelectMenuInteraction(interaction);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("no longer exists"),
      }),
    );
  });

  it("refuses a spoofed path outside the listing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delsess-"));
    const file = path.join(dir, "real.jsonl");
    fs.writeFileSync(file, "{}\n");
    mockListedFile(file);
    const spoof = path.join(dir, "spoof.jsonl");
    fs.writeFileSync(spoof, "{}\n");
    const interaction = mockDeleteSelect("ch-1", spoof);
    await handleSelectMenuInteraction(interaction);
    expect(fs.existsSync(spoof)).toBe(true);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not part of the project list"),
      }),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

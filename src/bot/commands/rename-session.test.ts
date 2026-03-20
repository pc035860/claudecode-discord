import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  renameSession: vi.fn(),
}));

vi.mock("./sessions.js", () => ({
  findSessionDir: vi.fn(),
}));

import fs from "node:fs";
import { execute } from "./rename-session.js";
import { getProject, getSession } from "../../db/database.js";
import { renameSession } from "@anthropic-ai/claude-agent-sdk";
import { findSessionDir } from "./sessions.js";

function mockInteraction(channelId: string, name: string) {
  return {
    channelId,
    options: {
      getString: vi.fn().mockReturnValue(name),
    },
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("rename-session command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replies with error when channel is not registered", async () => {
    vi.mocked(getProject).mockReturnValue(undefined as any);
    const interaction = mockInteraction("ch-1", "new-name");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("register"),
    });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("replies with error when no active session", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-2",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue(null as any);
    const interaction = mockInteraction("ch-2", "new-name");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("No active session"),
    });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("replies with error when session has no session_id", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-3",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-3",
      session_id: null,
      status: "idle",
      last_activity: null,
      created_at: "",
    } as any);
    const interaction = mockInteraction("ch-3", "new-name");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("No active session"),
    });
  });

  it("replies with failure when SDK renameSession throws", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-4",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-4",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    vi.mocked(renameSession).mockRejectedValueOnce(new Error("File not found"));
    const interaction = mockInteraction("ch-4", "new-name");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("Failed to rename"),
    });
  });

  it("renames session and replies with success embed", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-5",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-5",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    vi.mocked(renameSession).mockResolvedValueOnce(undefined);
    const interaction = mockInteraction("ch-5", "my-session");
    await execute(interaction);

    expect(renameSession).toHaveBeenCalledWith(
      "abc12345-0000-0000-0000-000000000000",
      "my-session",
      { dir: "/projects/myapp" },
    );
    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [expect.objectContaining({
        title: expect.stringContaining("Renamed"),
        description: expect.stringContaining("my-session"),
      })],
    });
  });

  it("rejects whitespace-only name", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-6",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-6",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    const interaction = mockInteraction("ch-6", "   ");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("empty"),
    });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("trims name before passing to SDK", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-8",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-8",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    vi.mocked(renameSession).mockResolvedValueOnce(undefined);
    const interaction = mockInteraction("ch-8", "  padded-name  ");
    await execute(interaction);
    expect(renameSession).toHaveBeenCalledWith(
      "abc12345-0000-0000-0000-000000000000",
      "padded-name",
      { dir: "/projects/myapp" },
    );
  });

  it("appends agent-name record to JSONL after rename", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-9",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-9",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    vi.mocked(renameSession).mockResolvedValueOnce(undefined);
    vi.mocked(findSessionDir).mockReturnValue("/fake/session-dir");
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});

    const interaction = mockInteraction("ch-9", "my-title");
    await execute(interaction);

    expect(appendSpy).toHaveBeenCalledWith(
      "/fake/session-dir/abc12345-0000-0000-0000-000000000000.jsonl",
      expect.stringContaining('"type":"agent-name"'),
    );
    const written = appendSpy.mock.calls[0][1] as string;
    expect(JSON.parse(written.trim())).toEqual({
      type: "agent-name",
      agentName: "my-title",
      sessionId: "abc12345-0000-0000-0000-000000000000",
    });

  });

  it("skips agent-name when session dir not found", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-10",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-10",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    vi.mocked(renameSession).mockResolvedValueOnce(undefined);
    vi.mocked(findSessionDir).mockReturnValue(null);
    const appendSpy = vi.spyOn(fs, "appendFileSync");

    const interaction = mockInteraction("ch-10", "my-title");
    await execute(interaction);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: expect.any(Array),
    });

  });

  it("includes error detail when SDK throws", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-7",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-7",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    vi.mocked(renameSession).mockRejectedValueOnce(new Error("ENOENT"));
    const interaction = mockInteraction("ch-7", "valid-name");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("ENOENT"),
    });
  });

  it("skips agent-name when JSONL file does not exist", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-11",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-11",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    vi.mocked(renameSession).mockResolvedValueOnce(undefined);
    vi.mocked(findSessionDir).mockReturnValue("/fake/session-dir");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const appendSpy = vi.spyOn(fs, "appendFileSync");

    const interaction = mockInteraction("ch-11", "my-title");
    await execute(interaction);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: expect.any(Array),
    });
  });

  it("still succeeds when agent-name write fails", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-12",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    vi.mocked(getSession).mockReturnValue({
      id: "db-id",
      channel_id: "ch-12",
      session_id: "abc12345-0000-0000-0000-000000000000",
      status: "online",
      last_activity: null,
      created_at: "",
    } as any);
    vi.mocked(renameSession).mockResolvedValueOnce(undefined);
    vi.mocked(findSessionDir).mockReturnValue("/fake/session-dir");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("EACCES"); });

    const interaction = mockInteraction("ch-12", "my-title");
    await execute(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [expect.objectContaining({
        title: expect.stringContaining("Renamed"),
      })],
    });
  });
});

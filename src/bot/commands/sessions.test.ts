import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
}));

vi.mock("../../utils/config.js", () => ({
  getConfig: vi.fn(() => ({})),
}));

vi.mock("../../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { list: vi.fn() },
  getAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { getProject, getSession } from "../../db/database.js";
import { execute } from "./sessions.js";

function mockInteraction(channelId: string) {
  return {
    channelId,
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function mockInfo(overrides: Record<string, any> = {}) {
  return {
    path: "/sessions/a.jsonl",
    id: "sess-a",
    cwd: "/tmp",
    name: undefined,
    created: new Date(),
    modified: new Date(),
    messageCount: 4,
    firstMessage: "hello world",
    allMessagesText: "hello world",
    ...overrides,
  };
}

describe("/sessions command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with error when channel not registered", async () => {
    vi.mocked(getProject).mockReturnValue(undefined);
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not registered"),
      }),
    );
  });

  it("shows 'new session' embed when no sessions exist", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/tmp",
      guild_id: "g-1",
      output_style: "seed",
      created_at: "",
    });
    vi.mocked(PiSessionManager.list).mockResolvedValue([]);
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].title).toContain("New Session");
  });

  it("renders select menu with active marker and delete button", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/tmp",
      guild_id: "g-1",
      output_style: "seed",
      created_at: "",
    });
    vi.mocked(getSession).mockReturnValue({
      id: "row-1",
      channel_id: "ch-1",
      session_id: null,
      agent_id: null,
      pi_session_file: "/sessions/a.jsonl",
      status: "idle",
      last_activity: null,
      created_at: "",
    });
    vi.mocked(PiSessionManager.list).mockResolvedValue([
      mockInfo({ path: "/sessions/a.jsonl", name: "Active session" }),
      mockInfo({
        path: "/sessions/b.jsonl",
        id: "sess-b",
        name: "Other session",
        firstMessage: "other work",
        modified: new Date(Date.now() - 3600_000),
      }),
    ]);
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].description).toContain("2");
    // select row + delete-button row
    expect(call.components).toHaveLength(2);
  });

  it("falls back to firstMessage when session has no name", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/tmp",
      guild_id: "g-1",
      output_style: "seed",
      created_at: "",
    });
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(PiSessionManager.list).mockResolvedValue([
      mockInfo({ name: undefined, firstMessage: "do the thing" }),
    ]);
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    const call = interaction.editReply.mock.calls[0][0];
    expect(JSON.stringify(call.components)).toContain("do the thing");
  });

  it("handles list errors gracefully", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/tmp",
      guild_id: "g-1",
      output_style: "seed",
      created_at: "",
    });
    vi.mocked(PiSessionManager.list).mockRejectedValue(new Error("disk down"));
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("disk down"),
      }),
    );
  });
});

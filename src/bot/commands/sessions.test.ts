import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
}));

vi.mock("../../utils/config.js", () => ({
  getConfig: vi.fn(() => ({ CURSOR_API_KEY: "test-key" })),
}));

vi.mock("../../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    list: vi.fn(),
  },
}));

import { Agent } from "@cursor/sdk";
import { getProject, getSession } from "../../db/database.js";
import { execute } from "./sessions.js";

function mockInteraction(channelId: string) {
  return {
    channelId,
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
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

  it("shows 'new session' embed when no agents exist", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/proj",
      guild_id: "g-1",
      auto_approve: 0,
      output_style: "seed",
      created_at: "",
    });
    vi.mocked(Agent.list).mockResolvedValue({ items: [] });
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].title).toContain("New Session");
  });

  it("renders select menu with active marker", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/proj",
      guild_id: "g-1",
      auto_approve: 0,
      output_style: "seed",
      created_at: "",
    });
    vi.mocked(getSession).mockReturnValue({
      id: "row-1",
      channel_id: "ch-1",
      session_id: null,
      agent_id: "agent-active",
      status: "idle",
      last_activity: null,
      created_at: "",
    });
    vi.mocked(Agent.list).mockResolvedValue({
      items: [
        {
          agentId: "agent-active",
          name: "Active session",
          summary: "summary",
          lastModified: Date.now(),
        },
        {
          agentId: "agent-other",
          name: "Other session",
          summary: "summary",
          lastModified: Date.now() - 3600_000,
        },
      ],
    } as any);
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].description).toContain("2");
    expect(call.components).toBeDefined();
  });

  it("filters out archived agents", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/proj",
      guild_id: "g-1",
      auto_approve: 0,
      output_style: "seed",
      created_at: "",
    });
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(Agent.list).mockResolvedValue({
      items: [
        {
          agentId: "agent-1",
          name: "Active",
          summary: "",
          lastModified: Date.now(),
        },
        {
          agentId: "agent-2",
          name: "Archived",
          summary: "",
          lastModified: Date.now(),
          archived: true,
        },
      ],
    } as any);
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    const call = interaction.editReply.mock.calls[0][0];
    expect(call.embeds[0].description).toContain("1");
  });

  it("handles Agent.list errors gracefully", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/proj",
      guild_id: "g-1",
      auto_approve: 0,
      output_style: "seed",
      created_at: "",
    });
    vi.mocked(Agent.list).mockRejectedValue(new Error("network down"));
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("network down"),
      }),
    );
  });
});

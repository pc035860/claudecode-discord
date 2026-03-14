import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  upsertSession: vi.fn(),
}));

import { execute } from "./new.js";
import { getProject, upsertSession } from "../../db/database.js";

function mockInteraction(channelId: string) {
  return {
    channelId,
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("new-session command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with error when channel is not registered", async () => {
    vi.mocked(getProject).mockReturnValue(undefined as any);
    const interaction = mockInteraction("ch-1");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("register"),
    });
    expect(upsertSession).not.toHaveBeenCalled();
  });

  it("creates session and replies with success embed", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-2",
      project_path: "/projects/myapp",
      guild_id: "g1",
      auto_approve: false,
    } as any);
    const interaction = mockInteraction("ch-2");
    await execute(interaction);

    expect(upsertSession).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      "ch-2",
      null,
      "idle",
    );

    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [expect.objectContaining({
        title: expect.stringContaining("New Session"),
        description: expect.stringContaining("/projects/myapp"),
      })],
    });
  });
});

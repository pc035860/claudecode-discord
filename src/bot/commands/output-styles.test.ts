import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  setOutputStyle: vi.fn(),
}));

vi.mock("../../claude/session-manager.js", () => ({
  listOutputStyles: vi.fn(() => ["ruru", "seed"]),
}));

vi.mock("../../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

import { getProject, setOutputStyle } from "../../db/database.js";
import { listOutputStyles } from "../../claude/session-manager.js";
import { autocomplete, execute } from "./output-styles.js";

function mockProject() {
  return {
    channel_id: "ch-1",
    project_path: "/tmp",
    guild_id: "g-1",
    output_style: "seed",
    created_at: "",
  };
}

function mockChatInteraction(style: string) {
  return {
    channelId: "ch-1",
    options: { getString: vi.fn(() => style) },
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("/output-styles command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listOutputStyles).mockReturnValue(["ruru", "seed"]);
  });

  it("replies with error when channel not registered", async () => {
    vi.mocked(getProject).mockReturnValue(undefined);
    const interaction = mockChatInteraction("ruru");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not registered"),
      }),
    );
    expect(setOutputStyle).not.toHaveBeenCalled();
  });

  it("rejects unknown style", async () => {
    vi.mocked(getProject).mockReturnValue(mockProject());
    const interaction = mockChatInteraction("nope");
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not found"),
      }),
    );
    expect(setOutputStyle).not.toHaveBeenCalled();
  });

  it("sets style and confirms with embed", async () => {
    vi.mocked(getProject).mockReturnValue(mockProject());
    const interaction = mockChatInteraction("ruru");
    await execute(interaction);
    expect(setOutputStyle).toHaveBeenCalledWith("ch-1", "ruru");
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            title: expect.stringContaining("ruru"),
          }),
        ]),
      }),
    );
  });

  it("autocomplete filters by focused text", async () => {
    const interaction = {
      options: { getFocused: vi.fn(() => "ru") },
      respond: vi.fn().mockResolvedValue(undefined),
    } as any;
    await autocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "ruru", value: "ruru" }]);
  });

  it("autocomplete returns all on empty input", async () => {
    const interaction = {
      options: { getFocused: vi.fn(() => "") },
      respond: vi.fn().mockResolvedValue(undefined),
    } as any;
    await autocomplete(interaction);
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "ruru", value: "ruru" },
      { name: "seed", value: "seed" },
    ]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
}));

vi.mock("../../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  SessionManager: { open: vi.fn(), create: vi.fn() },
}));

vi.mock("../../claude/session-manager.js", () => ({
  getPiModelRuntime: vi.fn(),
  getResourceLoader: vi.fn(),
  sessionManager: { isActive: vi.fn(() => false) },
}));

import { getProject, getSession } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { execute } from "./rename-session.js";

function mockInteraction() {
  return {
    channelId: "ch-1",
    options: { getString: vi.fn(() => "My Session") },
    editReply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("/rename-session command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionManager.isActive).mockReturnValue(false);
  });

  it("replies with error when channel not registered", async () => {
    vi.mocked(getProject).mockReturnValue(undefined);
    const interaction = mockInteraction();
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not registered"),
      }),
    );
  });

  it("refuses while a task is active", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/tmp",
      guild_id: "g-1",
      created_at: "",
    });
    vi.mocked(sessionManager.isActive).mockReturnValue(true);
    const interaction = mockInteraction();
    await execute(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("/stop"),
      }),
    );
  });

  it("sets the session name and links the file", async () => {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch-1",
      project_path: "/tmp",
      guild_id: "g-1",
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
    const setSessionName = vi.fn();
    const pi = await import("@earendil-works/pi-coding-agent");
    vi.mocked(pi.createAgentSession).mockResolvedValue({
      session: {
        setSessionName,
        sessionFile: "/sessions/a.jsonl",
        dispose: vi.fn(),
      },
    } as any);
    const interaction = mockInteraction();
    await execute(interaction);
    expect(setSessionName).toHaveBeenCalledWith("My Session");
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("My Session"),
      }),
    );
  });
});

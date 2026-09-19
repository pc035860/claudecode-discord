import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock better-sqlite3 to always use :memory:
vi.mock("better-sqlite3", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await vi.importActual("better-sqlite3") as any;
  const RealDatabase = actual.default;
  return {
    default: function MemoryDatabase(_path: string, options?: object) {
      return new RealDatabase(":memory:", options);
    },
  };
});

import {
  initDatabase,
  registerProject,
  unregisterProject,
  getProject,
  getAllProjects,
  upsertSession,
  getSession,
  updateSessionStatus,
  getAllSessions,
  findChannelsBySessionFile,
} from "./database.js";

describe("database", () => {
  beforeEach(() => {
    initDatabase();
  });

  // ─── Project CRUD ───

  describe("project CRUD", () => {
    it("registerProject + getProject", () => {
      registerProject("ch1", "/path/to/project", "guild1");
      const project = getProject("ch1");
      expect(project).toBeDefined();
      expect(project!.project_path).toBe("/path/to/project");
      expect(project!.guild_id).toBe("guild1");
    });

    it("registerProject with same channelId replaces existing", () => {
      registerProject("ch1", "/old/path", "guild1");
      registerProject("ch1", "/new/path", "guild1");
      const project = getProject("ch1");
      expect(project!.project_path).toBe("/new/path");
    });

    it("getProject returns undefined for non-existent channel", () => {
      expect(getProject("nonexistent")).toBeUndefined();
    });

    it("getAllProjects filters by guild", () => {
      registerProject("ch1", "/p1", "guild1");
      registerProject("ch2", "/p2", "guild1");
      registerProject("ch3", "/p3", "guild2");
      expect(getAllProjects("guild1")).toHaveLength(2);
      expect(getAllProjects("guild2")).toHaveLength(1);
      expect(getAllProjects("guild3")).toHaveLength(0);
    });

    it("unregisterProject removes project and cascades to sessions", () => {
      registerProject("ch1", "/p1", "guild1");
      upsertSession("s1", "ch1", null, "online");
      unregisterProject("ch1");
      expect(getProject("ch1")).toBeUndefined();
      expect(getSession("ch1")).toBeUndefined();
    });

  });

  // ─── Session CRUD ───

  describe("session CRUD", () => {
    beforeEach(() => {
      registerProject("ch1", "/p1", "guild1");
    });

    it("upsertSession + getSession", () => {
      upsertSession("s1", "ch1", "/sessions/abc.jsonl", "online");
      const session = getSession("ch1");
      expect(session).toBeDefined();
      expect(session!.pi_session_file).toBe("/sessions/abc.jsonl");
      expect(session!.session_id).toBeNull();
      expect(session!.agent_id).toBeNull();
      expect(session!.status).toBe("online");
    });

    it("upsertSession replaces existing session with same id", () => {
      upsertSession("s1", "ch1", null, "online");
      upsertSession("s1", "ch1", "/sessions/abc.jsonl", "idle");
      const session = getSession("ch1");
      expect(session!.pi_session_file).toBe("/sessions/abc.jsonl");
      expect(session!.status).toBe("idle");
    });

    it("upsertSession with null sessionFile", () => {
      upsertSession("s1", "ch1", null, "online");
      const session = getSession("ch1");
      expect(session!.pi_session_file).toBeNull();
    });

    it("updateSessionStatus changes status", () => {
      upsertSession("s1", "ch1", null, "online");
      updateSessionStatus("ch1", "idle");
      expect(getSession("ch1")!.status).toBe("idle");
    });

    it("getAllSessions joins with projects", () => {
      registerProject("ch2", "/p2", "guild1");
      upsertSession("s1", "ch1", null, "online");
      upsertSession("s2", "ch2", null, "idle");
      const sessions = getAllSessions("guild1");
      expect(sessions).toHaveLength(2);
      expect(sessions[0].project_path).toBeDefined();
    });

    it("getAllSessions returns empty for guild with no sessions", () => {
      registerProject("ch2", "/p2", "guild2");
      expect(getAllSessions("guild2")).toHaveLength(0);
    });

    it("findChannelsBySessionFile returns linking channels", () => {
      registerProject("ch1", "/p1", "guild1");
      registerProject("ch2", "/p2", "guild1");
      registerProject("ch3", "/p3", "guild1");
      upsertSession("s1", "ch1", "/sessions/a.jsonl", "idle");
      upsertSession("s2", "ch2", "/sessions/a.jsonl", "idle");
      upsertSession("s3", "ch3", "/sessions/b.jsonl", "idle");
      expect(findChannelsBySessionFile("/sessions/a.jsonl").sort()).toEqual([
        "ch1",
        "ch2",
      ]);
      expect(findChannelsBySessionFile("/sessions/missing.jsonl")).toEqual([]);
    });
  });
});

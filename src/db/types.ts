export type SessionStatus = "online" | "offline" | "idle";

export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  created_at: string;
}

export interface Session {
  id: string;
  channel_id: string;
  session_id: string | null; // legacy Claude session ID (unused after Cursor SDK migration)
  agent_id: string | null; // legacy Cursor SDK agent ID (unused after Pi SDK migration)
  pi_session_file: string | null; // Pi Agent SDK session JSONL path
  status: SessionStatus;
  last_activity: string | null;
  created_at: string;
}

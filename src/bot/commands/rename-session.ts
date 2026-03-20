import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { renameSession } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { getProject, getSession } from "../../db/database.js";
import { findSessionDir } from "./sessions.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("rename-session")
  .setDescription("Rename the current Claude Code session")
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("New session name")
      .setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);

  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project. Use `/register` first.",
        "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다. 먼저 `/register`를 사용하세요.",
      ),
    });
    return;
  }

  const session = getSession(channelId);
  if (!session?.session_id) {
    await interaction.editReply({
      content: L(
        "No active session in this channel. Start a conversation first.",
        "이 채널에 활성 세션이 없습니다. 먼저 대화를 시작하세요.",
      ),
    });
    return;
  }

  const name = interaction.options.getString("name", true).trim();

  if (!name) {
    await interaction.editReply({
      content: L(
        "Session name cannot be empty.",
        "세션 이름은 비어 있을 수 없습니다.",
      ),
    });
    return;
  }

  try {
    await renameSession(session.session_id, name, { dir: project.project_path });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn("[rename-session] Failed:", detail);
    const short = detail.slice(0, 100);
    await interaction.editReply({
      content: L(
        `Failed to rename session: ${short}`,
        `세션 이름 변경에 실패했습니다: ${short}`,
      ),
    });
    return;
  }

  try {
    const sessionDir = findSessionDir(project.project_path);
    if (sessionDir) {
      const jsonlPath = path.join(sessionDir, `${session.session_id}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        const record = JSON.stringify({ type: "agent-name", agentName: name, sessionId: session.session_id });
        fs.appendFileSync(jsonlPath, record + "\n");
      }
    }
  } catch (e) {
    console.warn("[rename-session] Failed to write agent-name:", e instanceof Error ? e.message : e);
  }

  await interaction.editReply({
    embeds: [
      {
        title: L("Session Renamed", "세션 이름 변경됨"),
        description: L(
          `Session \`${session.session_id.slice(0, 8)}...\` renamed to **${name}**`,
          `세션 \`${session.session_id.slice(0, 8)}...\` 이름이 **${name}**(으)로 변경되었습니다`,
        ),
        color: 0x5865f2,
      },
    ],
  });
}

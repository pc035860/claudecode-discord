import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { getProject, upsertSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("new-session")
  .setDescription("Start a new Claude Code session in this channel");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);

  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project. Use `/register` first.",
        "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다. 먼저 `/register`를 사용하세요."
      ),
    });
    return;
  }

  // Create a new session by setting session_id to null
  const { randomUUID } = await import("node:crypto");
  upsertSession(randomUUID(), channelId, null, "idle");

  await interaction.editReply({
    embeds: [
      {
        title: L("✨ New Session", "✨ 새 세션"),
        description: L(
          `New session is ready for \`${project.project_path}\`.\nA new conversation will start from your next message.`,
          `\`${project.project_path}\`에 대한 새 세션이 준비되었습니다.\n다음 메시지부터 새로운 대화가 시작됩니다.`
        ),
        color: 0x00ff00,
      },
    ],
  });
}

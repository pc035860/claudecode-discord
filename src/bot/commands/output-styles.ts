import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { getProject, setOutputStyle } from "../../db/database.js";
import { listOutputStyles } from "../../utils/rules-loader.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("output-styles")
  .setDescription("Set the output style (persona) for this channel")
  .addStringOption((opt) =>
    opt
      .setName("style")
      .setDescription("Output style name")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const styles = listOutputStyles();
  const filtered = styles.filter((s) => s.toLowerCase().includes(focused)).slice(0, 25);
  await interaction.respond(
    filtered.map((s) => ({ name: s, value: s })),
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);

  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project.",
        "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다.",
      ),
    });
    return;
  }

  const style = interaction.options.getString("style", true);
  const available = listOutputStyles();

  if (!available.includes(style)) {
    await interaction.editReply({
      content: L(
        `Style \`${style}\` not found. Available: ${available.map((s) => `\`${s}\``).join(", ")}`,
        `스타일 \`${style}\`을(를) 찾을 수 없습니다. 사용 가능: ${available.map((s) => `\`${s}\``).join(", ")}`,
      ),
    });
    return;
  }

  setOutputStyle(channelId, style);

  await interaction.editReply({
    embeds: [
      {
        title: L(`Output Style: \`${style}\``, `출력 스타일: \`${style}\``),
        description: L(
          "Style updated. Will take effect from the next message (resumes current conversation).",
          "스타일이 업데이트되었습니다. 다음 메시지부터 적용됩니다 (현재 대화 이어짐).",
        ),
        color: 0x5865f2,
      },
    ],
  });
}

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { getPiModelRuntime } from "../../claude/session-manager.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("models")
  .setDescription("List available Pi models (authenticated providers only)");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = getConfig();

  try {
    const runtime = await getPiModelRuntime();
    const models = await runtime.getAvailable();

    if (models.length === 0) {
      await interaction.editReply({
        content: L("No models available.", "사용 가능한 모델이 없습니다."),
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(L("Pi Models", "Pi 모델"))
      .setColor(0x7c3aed)
      .setDescription(
        L(
          `Current default: \`${config.PI_MODEL}\``,
          `현재 기본값: \`${config.PI_MODEL}\``,
        ),
      )
      .setTimestamp();

    for (const m of models.slice(0, 25)) {
      const provider = (m as { provider?: string }).provider ?? "?";
      embed.addFields({
        name: `\`${m.id}\` [${provider}]`.slice(0, 256),
        value: (m as { name?: string }).name ?? "​",
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await interaction.editReply({
      content: L(`Failed to list models: ${msg}`, `모델 목록을 가져오지 못했습니다: ${msg}`),
    });
  }
}

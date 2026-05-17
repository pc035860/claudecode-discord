import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { Cursor } from "@cursor/sdk";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("cursor-models")
  .setDescription("List available Cursor SDK models");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = getConfig();

  try {
    const models = await Cursor.models.list({ apiKey: config.CURSOR_API_KEY });

    if (models.length === 0) {
      await interaction.editReply({
        content: L("No models available.", "사용 가능한 모델이 없습니다."),
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(L("Cursor SDK Models", "Cursor SDK 모델"))
      .setColor(0x7c3aed)
      .setDescription(
        L(
          `Current default: \`${config.CURSOR_MODEL}\``,
          `현재 기본값: \`${config.CURSOR_MODEL}\``,
        ),
      )
      .setTimestamp();

    for (const m of models.slice(0, 25)) {
      const aliases = m.aliases?.length ? `\n${L("Aliases", "별칭")}: ${m.aliases.map((a) => `\`${a}\``).join(", ")}` : "";
      const variants = m.variants?.length
        ? `\n${L("Variants", "변형")}: ${m.variants
            .map((v) => v.displayName)
            .join(", ")}`
        : "";
      const value = [m.description ?? "", aliases, variants]
        .filter(Boolean)
        .join("")
        .slice(0, 1024) || "​";
      embed.addFields({
        name: `\`${m.id}\` — ${m.displayName}`.slice(0, 256),
        value,
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await interaction.editReply({
      content: L(
        `Failed to list models: ${msg}`,
        `모델 목록을 가져오지 못했습니다: ${msg}`,
      ),
    });
  }
}

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { L } from "../utils/i18n.js";

export const MAX_DISCORD_LENGTH = 1900; // leave room for formatting

export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt === -1 || splitAt < MAX_DISCORD_LENGTH / 2) {
      splitAt = MAX_DISCORD_LENGTH;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    const fenceRegex = /^```/gm;
    let insideBlock = false;
    let blockLang = "";
    let match;
    while ((match = fenceRegex.exec(chunk)) !== null) {
      if (insideBlock) {
        insideBlock = false;
        blockLang = "";
      } else {
        insideBlock = true;
        const lineEnd = chunk.indexOf("\n", match.index);
        blockLang = chunk.slice(match.index + 3, lineEnd === -1 ? undefined : lineEnd).trim();
      }
    }

    if (insideBlock) {
      chunk += "\n```";
      remaining = "```" + blockLang + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

export function createStopButton(
  channelId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop:${channelId}`)
      .setLabel(L("Stop", "중지"))
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⏹️"),
  );
}

export function createCompletedButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("completed")
      .setLabel(L("Completed", "완료됨"))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✅")
      .setDisabled(true),
  );
}

export function createResultEmbed(
  result: string,
  costUsd: number,
  durationMs: number,
  showCost: boolean = true,
): EmbedBuilder {
  const duration = `${(durationMs / 1000).toFixed(1)}s`;
  const footer = showCost
    ? `${L("Cost (est.)", "비용 (추정)")} : $${costUsd.toFixed(4)}  |  ${L("Duration", "소요 시간")} : ${duration}`
    : `${L("Duration", "소요 시간")} : ${duration}`;

  const embed = new EmbedBuilder()
    .setTitle(L("✅ Task Complete", "✅ 작업 완료"))
    .setDescription(result.slice(0, 4000))
    .setColor(0x00ff00)
    .setFooter({ text: footer })
    .setTimestamp();

  return embed;
}

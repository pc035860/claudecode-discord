import {
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type TextChannel,
} from "discord.js";
import path from "node:path";
import fs from "node:fs";
import { L } from "../utils/i18n.js";

export const MAX_DISCORD_LENGTH = 1900; // leave room for formatting

const ALLOWED_PREFIXES = ["/tmp", "/private/tmp"]; // macOS /tmp -> /private/tmp
const MAX_ATTACHMENTS = 10;

// Returns the realpath-resolved path when it falls inside `allowed`, else
// null. Callers must use the returned string (not the raw input) for any
// subsequent reads, otherwise a symlink swap between check and use would
// bypass the allowlist.
function resolveIfAllowed(
  filePath: string,
  allowed: readonly string[],
): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(filePath);
  } catch {
    resolved = path.resolve(filePath);
  }
  const ok = allowed.some(
    (prefix) => resolved.startsWith(prefix + "/") || resolved === prefix,
  );
  return ok ? resolved : null;
}

export function extractAttachments(text: string): {
  cleanText: string;
  attachmentPaths: string[];
} {
  const attachmentPaths: string[] = [];
  const cleanText = text
    .replace(/^[ \t]*[-*]\s*\[ATTACH:\s*([^\]\r\n]+)\]\s*$/gm, (_, p) => {
      attachmentPaths.push(p.trim());
      return "";
    })
    .replace(/\s*\[ATTACH:\s*([^\]\r\n]+)\]\s*/g, (_, p) => {
      attachmentPaths.push(p.trim());
      return " ";
    })
    .replace(/  +/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, attachmentPaths };
}

export async function sendAttachments(
  channel: Pick<TextChannel, "send">,
  attachmentPaths: string[],
  projectPath?: string,
): Promise<void> {
  const unique = [...new Set(attachmentPaths)];
  const capped = unique.slice(0, MAX_ATTACHMENTS);
  if (unique.length > MAX_ATTACHMENTS) {
    console.warn(
      `[attach] Too many attachments (${unique.length}), sending first ${MAX_ATTACHMENTS}`,
    );
  }

  const allowed = projectPath
    ? [...ALLOWED_PREFIXES, path.resolve(projectPath)]
    : ALLOWED_PREFIXES;

  const skipWith = async (filePath: string, en: string, kr: string) => {
    console.warn(`[attach] ${en}: ${filePath}`);
    await channel.send(
      L(`⚠️ ${en}: \`${filePath}\``, `⚠️ ${kr}: \`${filePath}\``),
    );
  };

  const validFiles: AttachmentBuilder[] = [];
  for (const filePath of capped) {
    const resolved = resolveIfAllowed(filePath, allowed);
    if (resolved === null) {
      await skipWith(
        filePath,
        "Attachment blocked (outside allowed paths)",
        "첨부 파일 차단 (路徑不在允許範圍)",
      );
      continue;
    }
    if (!fs.existsSync(resolved)) {
      await skipWith(filePath, "Attachment not found", "첨부 파일不存在");
      continue;
    }
    validFiles.push(new AttachmentBuilder(resolved));
  }

  if (validFiles.length > 0) {
    try {
      await channel.send({ files: validFiles });
    } catch (e) {
      console.warn(
        `[attach] Failed to send attachments:`,
        e instanceof Error ? e.message : e,
      );
      await channel.send(
        L(`⚠️ Failed to send attachment(s)`, `⚠️ 첨부 파일 전송 실패`),
      );
    }
  }
}

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

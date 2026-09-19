import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { getProject, getSession, upsertSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";

export const NEW_SESSION_SENTINEL = "__new_session__";
const SESSION_LIST_LIMIT = 25;

export interface PiSessionEntry {
  filePath: string;
  name: string;
  preview: string;
  messageCount: number;
  lastModified: number;
}

export async function listProjectSessions(projectPath: string): Promise<PiSessionEntry[]> {
  // Session files live in per-cwd buckets (~/.pi/agent/sessions/--<cwd>--/),
  // so list() is inherently project-scoped — no cross-project leakage.
  const infos = await PiSessionManager.list(fs.realpathSync(projectPath));
  return infos.slice(0, SESSION_LIST_LIMIT).map((info) => ({
    filePath: info.path,
    name: info.name || info.firstMessage || `Session ${info.id.slice(0, 8)}`,
    preview: info.firstMessage || "",
    messageCount: info.messageCount,
    lastModified: info.modified.getTime(),
  }));
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return L("just now", "방금");
  if (min < 60) return L(`${min}m ago`, `${min}분 전`);
  const hr = Math.floor(diffMs / 3600000);
  if (hr < 24) return L(`${hr}h ago`, `${hr}시간 전`);
  const day = Math.floor(diffMs / 86400000);
  if (day < 7) return L(`${day}d ago`, `${day}일 전`);
  return new Date(ts).toLocaleDateString(L("en-US", "ko-KR"), {
    month: "short",
    day: "numeric",
  });
}

export const data = new SlashCommandBuilder()
  .setName("sessions")
  .setDescription("List, resume, or delete Pi agent sessions for this project");

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

  let sessions: PiSessionEntry[];
  try {
    sessions = await listProjectSessions(project.project_path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await interaction.editReply({
      content: L(
        `Failed to list sessions: ${msg}`,
        `세션 목록을 가져오지 못했습니다: ${msg}`,
      ),
    });
    return;
  }

  if (sessions.length === 0) {
    upsertSession(randomUUID(), channelId, null, "idle");
    await interaction.editReply({
      embeds: [
        {
          title: L("✨ New Session", "✨ 새 세션"),
          description: L(
            `No existing sessions found for \`${project.project_path}\`.\nA new session is ready — your next message will start a new conversation.`,
            `\`${project.project_path}\`에 대한 기존 세션이 없습니다.\n새 세션이 준비되었습니다 — 다음 메시지부터 새로운 대화가 시작됩니다.`,
          ),
          color: 0x00ff00,
        },
      ],
    });
    return;
  }

  const dbSession = getSession(channelId);
  const activeFile = dbSession?.pi_session_file ?? null;

  const options: Array<{
    label: string;
    description: string;
    value: string;
    default?: boolean;
  }> = [
    {
      label: L("✨ Create New Session", "✨ 새 세션 만들기"),
      description: L(
        "Start a new conversation without an existing session",
        "기존 세션 없이 새로운 대화를 시작합니다",
      ),
      value: NEW_SESSION_SENTINEL,
    },
  ];

  const sessionOptions = sessions.slice(0, 24).map((s) => {
    const timeStr = formatRelativeTime(s.lastModified);
    const isActive = s.filePath === activeFile;
    const label = isActive
      ? `▶ ${s.name.slice(0, 48)}`
      : s.name.slice(0, 50);
    const desc = isActive
      ? `${L("Active", "사용 중")} | ${s.messageCount} msgs | ${timeStr}`
      : `${s.messageCount} msgs | ${timeStr}`;

    return {
      label,
      description: desc.slice(0, 100),
      value: s.filePath,
      default: isActive,
    };
  });

  options.push(...sessionOptions);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("session-select")
    .setPlaceholder(L("Select a session to resume...", "재개할 세션을 선택하세요..."))
    .addOptions(options);

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  const deleteButton = new ButtonBuilder()
    .setCustomId(`session-delete-list:${channelId}`)
    .setLabel(L("🗑️ Delete a session...", "🗑️ 세션 삭제..."))
    .setStyle(ButtonStyle.Danger);
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(deleteButton);

  await interaction.editReply({
    embeds: [
      {
        title: L("Pi Agent Sessions", "Pi 에이전트 세션"),
        description: [
          `Project: \`${project.project_path}\``,
          L(
            `Found **${sessions.length}** session(s) for this project`,
            `이 프로젝트에서 **${sessions.length}**개의 세션을 찾았습니다`,
          ),
        ].join("\n"),
        color: 0x7c3aed,
      },
    ],
    components: [selectRow, buttonRow],
  });
}

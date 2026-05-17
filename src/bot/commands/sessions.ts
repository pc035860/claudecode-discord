import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { Agent } from "@cursor/sdk";
import { getProject, getSession, upsertSession } from "../../db/database.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";

interface SessionInfo {
  agentId: string;
  name: string;
  summary: string;
  lastModified: number;
}

async function listAgents(projectPath: string): Promise<SessionInfo[]> {
  const result = await Agent.list({ runtime: "local", cwd: projectPath });
  return result.items
    .filter((a) => !a.archived)
    .map((a) => ({
      agentId: a.agentId,
      name: a.name,
      summary: a.summary,
      lastModified: a.lastModified,
    }))
    .sort((a, b) => b.lastModified - a.lastModified);
}

export const data = new SlashCommandBuilder()
  .setName("sessions")
  .setDescription("List and resume existing Cursor agent sessions for this project");

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

  // Ensure Cursor SDK has API key available before listing
  getConfig();

  let sessions: SessionInfo[];
  try {
    sessions = await listAgents(project.project_path);
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
    const { randomUUID } = await import("node:crypto");
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
  const activeAgentId = dbSession?.agent_id ?? null;

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
      value: "__new_session__",
    },
  ];

  const sessionOptions = sessions.slice(0, 24).map((s, i) => {
    const diffMs = Date.now() - s.lastModified;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);
    const timeStr =
      diffMin < 1
        ? L("just now", "방금")
        : diffMin < 60
          ? L(`${diffMin}m ago`, `${diffMin}분 전`)
          : diffHr < 24
            ? L(`${diffHr}h ago`, `${diffHr}시간 전`)
            : diffDay < 7
              ? L(`${diffDay}d ago`, `${diffDay}일 전`)
              : new Date(s.lastModified).toLocaleDateString(
                  L("en-US", "ko-KR"),
                  { month: "short", day: "numeric" },
                );

    const isActive = s.agentId === activeAgentId;
    const displayName = s.name || s.summary || `Session ${i + 1}`;
    const label = isActive
      ? `▶ ${displayName.slice(0, 48)}`
      : displayName.slice(0, 50);
    const desc = isActive
      ? `${L("Active", "사용 중")} | ${timeStr} | ${s.agentId.slice(0, 8)}...`
      : `${timeStr} | ${s.agentId.slice(0, 12)}...`;

    return {
      label,
      description: desc.slice(0, 100),
      value: s.agentId,
      default: isActive,
    };
  });

  options.push(...sessionOptions);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("session-select")
    .setPlaceholder(L("Select a session to resume...", "재개할 세션을 선택하세요..."))
    .addOptions(options);

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  await interaction.editReply({
    embeds: [
      {
        title: L("Cursor Agent Sessions", "Cursor 에이전트 세션"),
        description: [
          `Project: \`${project.project_path}\``,
          L(
            `Found **${sessions.length}** session(s)`,
            `**${sessions.length}**개의 세션을 찾았습니다`,
          ),
          "",
          L(
            "Select a session below to resume it.",
            "아래에서 세션을 선택하여 재개하세요.",
          ),
        ].join("\n"),
        color: 0x7c3aed,
      },
    ],
    components: [row],
  });
}

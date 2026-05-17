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

async function listAgents(): Promise<SessionInfo[]> {
  // Cursor SDK Agent.list() returns the platform workspaceRef as `cwd`, not
  // the per-run `local.cwd` we passed at create time. There is no reliable
  // way to project-scope from SDKAgentInfo today, so we list all non-archived
  // local agents on this bot's host and let the user pick by name + recency.
  const result = await Agent.list({ runtime: "local" });
  return result.items
    .filter((a) => !a.archived && a.runtime === "local")
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
    sessions = await listAgents();
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
            `Found **${sessions.length}** local agent(s) in this bot workspace`,
            `이 봇 워크스페이스에서 **${sessions.length}**개의 로컬 에이전트를 찾았습니다`,
          ),
          "",
          L(
            "Cursor SDK does not expose per-project scoping; agents from other projects on this workspace may appear here. Pick by name / recency.",
            "Cursor SDK는 프로젝트별 범위 지정을 지원하지 않으므로 이 워크스페이스의 다른 프로젝트 에이전트도 나타날 수 있습니다. 이름과 최근 시각으로 선택하세요.",
          ),
        ].join("\n"),
        color: 0x7c3aed,
      },
    ],
    components: [row],
  });
}

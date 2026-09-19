import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { isAllowedUser } from "../../security/guard.js";
import { sessionManager } from "../../claude/session-manager.js";
import {
  findChannelsBySessionFile,
  getProject,
  getSession,
  upsertSession,
} from "../../db/database.js";
import {
  NEW_SESSION_SENTINEL,
  listProjectSessions,
} from "../commands/sessions.js";
import { L } from "../../utils/i18n.js";

function shortSessionLabel(filePath: string): string {
  const base = path.basename(filePath, ".jsonl");
  return base.length > 24 ? `...${base.slice(-20)}` : base;
}

async function applyResume(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  sessionFile: string,
): Promise<void> {
  upsertSession(randomUUID(), interaction.channelId, sessionFile, "idle");
  await interaction.update({
    embeds: [
      {
        title: L("Session Resumed", "세션 재개됨"),
        description: L(
          `Session: \`${shortSessionLabel(sessionFile)}\`\n\nNext message you send will resume this conversation.`,
          `세션: \`${shortSessionLabel(sessionFile)}\`\n\n다음 메시지부터 이 대화가 재개됩니다.`,
        ),
        color: 0x00ff00,
      },
    ],
    components: [],
  });
}

async function applyNewSession(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  channelId: string,
): Promise<void> {
  upsertSession(randomUUID(), channelId, null, "idle");
  await interaction.update({
    embeds: [
      {
        title: L("✨ New Session", "✨ 새 세션"),
        description: L(
          "New session is ready.\nA new conversation will start from your next message.",
          "새 세션이 준비되었습니다.\n다음 메시지부터 새로운 대화가 시작됩니다.",
        ),
        color: 0x00ff00,
      },
    ],
    components: [],
  });
}

export async function handleButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  const customId = interaction.customId;
  const colonIndex = customId.indexOf(":");
  const action = colonIndex === -1 ? customId : customId.slice(0, colonIndex);
  const requestId = colonIndex === -1 ? "" : customId.slice(colonIndex + 1);

  if (!requestId && action !== "completed") {
    await interaction.reply({
      content: L("Invalid button interaction.", "잘못된 버튼 상호작용입니다."),
      ephemeral: true,
    });
    return;
  }

  if (action === "stop") {
    const channelId = requestId;
    const stopped = await sessionManager.stopSession(channelId);
    await interaction.update({
      content: L("⏹️ Task has been stopped.", "⏹️ 작업이 중지되었습니다."),
      components: [],
    });
    if (!stopped) {
      await interaction.followUp({
        content: L("No active session.", "활성 세션이 없습니다."),
        ephemeral: true,
      });
    }
    return;
  }

  if (action === "queue-yes") {
    const channelId = requestId;
    const confirmed = sessionManager.confirmQueue(channelId);
    if (!confirmed) {
      await interaction.update({
        content: L("⏳ Queue request has expired.", "⏳ 큐 요청이 만료되었습니다."),
        components: [],
      });
      return;
    }
    const queueSize = sessionManager.getQueueSize(channelId);
    await interaction.update({
      content: L(
        `📨 Message added to queue (${queueSize}/5). It will be processed after the current task.`,
        `📨 메시지가 큐에 추가되었습니다 (${queueSize}/5). 이전 작업 완료 후 자동으로 처리됩니다.`,
      ),
      components: [],
    });
    return;
  }

  if (action === "queue-no") {
    sessionManager.cancelQueue(requestId);
    await interaction.update({
      content: L("Cancelled.", "취소되었습니다."),
      components: [],
    });
    return;
  }

  if (action === "session-resume") {
    await applyResume(interaction, requestId);
    return;
  }

  if (action === "session-delete-list") {
    const channelId = requestId;
    const project = getProject(channelId);
    if (!project) {
      await interaction.reply({
        content: L("Channel is not registered to any project.", "등록된 프로젝트가 없습니다."),
        ephemeral: true,
      });
      return;
    }
    let sessions;
    try {
      sessions = await listProjectSessions(project.project_path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
      return;
    }
    const dbSession = getSession(channelId);
    const linkedFile = dbSession?.pi_session_file ?? null;
    if (sessions.length === 0) {
      await interaction.update({
        content: L("No sessions left to delete.", "삭제할 세션이 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }
    const deleteOptions = sessions.map((s) => ({
      label: (s.filePath === linkedFile ? `🔒 ${s.name}` : s.name).slice(0, 50),
      description: `${s.messageCount} msgs | ${shortSessionLabel(s.filePath)}`.slice(0, 100),
      value: s.filePath,
    }));
    const deleteMenu = new StringSelectMenuBuilder()
      .setCustomId("session-delete-select")
      .setPlaceholder(L("Select a session to DELETE...", "삭제할 세션을 선택하세요..."))
      .addOptions(deleteOptions.slice(0, 25));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(deleteMenu);
    await interaction.update({
      content: L(
        "⚠️ Select a session to permanently delete. The session linked to this channel (🔒) cannot be deleted — switch to a new session first.",
        "⚠️ 영구 삭제할 세션을 선택하세요. 이 채널에 연결된 세션(🔒)은 삭제할 수 없습니다 — 먼저 새 세션으로 전환하세요.",
      ),
      embeds: [],
      components: [row],
    });
    return;
  }

  if (action === "session-cancel") {
    await interaction.update({
      content: L("Cancelled.", "취소되었습니다."),
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "queue-clear") {
    const channelId = requestId;
    const cleared = sessionManager.clearQueue(channelId);
    await interaction.update({
      embeds: [
        {
          title: L("Queue Cleared", "큐 초기화됨"),
          description: L(
            `Cleared ${cleared} queued message(s).`,
            `${cleared}개의 대기 중이던 메시지를 취소했습니다.`,
          ),
          color: 0xff6600,
        },
      ],
      components: [],
    });
    return;
  }

  if (action === "queue-remove") {
    const lastColon = requestId.lastIndexOf(":");
    const channelId = requestId.slice(0, lastColon);
    const index = parseInt(requestId.slice(lastColon + 1), 10);
    const removed = sessionManager.removeFromQueue(channelId, index);

    if (!removed) {
      await interaction.update({
        content: L("This item is no longer in the queue.", "이 항목은 이미 큐에 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }

    const preview = removed.length > 60 ? removed.slice(0, 60) + "…" : removed;
    const queue = sessionManager.getQueue(channelId);
    if (queue.length === 0) {
      await interaction.update({
        embeds: [
          {
            title: L("Message Removed", "메시지 취소됨"),
            description: L(
              `Removed: ${preview}\n\nQueue is now empty.`,
              `취소됨: ${preview}\n\n큐가 비었습니다.`,
            ),
            color: 0xff6600,
          },
        ],
        components: [],
      });
      return;
    }

    const list = queue
      .map((item: { prompt: string }, idx: number) => {
        const p = item.prompt.length > 100 ? item.prompt.slice(0, 100) + "…" : item.prompt;
        return `**${idx + 1}.** ${p}`;
      })
      .join("\n\n");

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const itemButtons = queue.map((_: unknown, idx: number) =>
      new ButtonBuilder()
        .setCustomId(`queue-remove:${channelId}:${idx}`)
        .setLabel(`❌ ${idx + 1}`)
        .setStyle(ButtonStyle.Secondary),
    );
    const clearButton = new ButtonBuilder()
      .setCustomId(`queue-clear:${channelId}`)
      .setLabel(L("Clear All", "모두 취소"))
      .setStyle(ButtonStyle.Danger);

    const allButtons = [...itemButtons.slice(0, 19), clearButton];
    for (let i = 0; i < allButtons.length; i += 5) {
      const chunk = allButtons.slice(i, i + 5);
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...chunk));
    }

    await interaction.update({
      embeds: [
        {
          title: L(
            `📋 Message Queue (${queue.length})`,
            `📋 메시지 큐 (${queue.length}개)`,
          ),
          description: `~~${preview}~~ ${L("removed", "취소됨")}\n\n${list}`,
          color: 0x5865f2,
        },
      ],
      components: rows,
    });
    return;
  }

  // Unknown action — likely an orphan customId from a pre-migration message.
  // Ack so Discord doesn't show "interaction failed".
  try {
    await interaction.reply({
      content: L("This button has expired.", "이 버튼은 만료되었습니다."),
      ephemeral: true,
    });
  } catch {
    // ignore — interaction may already be acknowledged
  }
}

export async function handleSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: L("You are not authorized.", "권한이 없습니다."),
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === "session-delete-select") {
    const rawValue = interaction.values[0];
    const channelId = interaction.channelId;
    const project = getProject(channelId);
    if (!project) {
      await interaction.update({
        content: L("Channel is not registered to any project.", "등록된 프로젝트가 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }
    // Allowlist: only delete paths that appear in a FRESH project listing.
    // This rejects spoofed values and already-deleted files alike.
    let listed: string[];
    try {
      const sessions = await listProjectSessions(project.project_path);
      listed = [];
      for (const s of sessions) {
        try {
          listed.push(fs.realpathSync(s.filePath));
        } catch {
          // Vanished between list() and now (concurrent delete) —
          // just exclude it instead of failing the whole verification.
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await interaction.update({
        content: `❌ ${L("Could not verify session:", "세션 확인 실패:")} ${msg}`,
        embeds: [],
        components: [],
      });
      return;
    }
    let filePath: string;
    try {
      filePath = fs.realpathSync(rawValue);
    } catch {
      await interaction.update({
        content: L("This session file no longer exists.", "이 세션 파일은 이미 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }
    if (!listed.includes(filePath)) {
      await interaction.update({
        content: L("This session is not part of the project list.", "이 세션은 프로젝트 목록에 없습니다."),
        embeds: [],
        components: [],
      });
      return;
    }
    // Refuse when ANY channel references the file — the list is
    // project-scoped, so another channel on the same project may own it
    // or be actively writing to it.
    const linkedChannels = findChannelsBySessionFile(filePath);
    // The stored path may be non-canonical (saved pre-realpath through a
    // symlink), so also match the raw value — do NOT simplify this away.
    const rawLinked = findChannelsBySessionFile(rawValue);
    const owners = [...new Set([...linkedChannels, ...rawLinked])];
    if (owners.length > 0) {
      const mine = owners.length === 1 && owners[0] === channelId;
      await interaction.update({
        content: mine
          ? L(
            "🔒 This session is linked to the current channel and cannot be deleted. Use `/sessions` → Create New Session first, then delete it.",
            "🔒 이 세션은 현재 채널에 연결되어 있어 삭제할 수 없습니다. `/sessions`에서 새 세션을 먼저 만든 뒤 삭제하세요.",
          )
          : L(
            `🔒 This session is linked to ${owners.length === 1 ? "another channel" : `${owners.length} channels`} and cannot be deleted.`,
            `🔒 이 세션은 다른 채널에 연결되어 있어 삭제할 수 없습니다.`,
          ),
        embeds: [],
        components: [],
      });
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await interaction.update({
        content: `❌ ${L("Delete failed:", "삭제 실패:")} ${msg}`,
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.update({
      content: L(
        `🗑️ Deleted session \`${shortSessionLabel(filePath)}\`.`,
        `🗑️ 세션 \`${shortSessionLabel(filePath)}\`을(를) 삭제했습니다.`,
      ),
      embeds: [],
      components: [],
    });
    return;
  }

  if (interaction.customId !== "session-select") return;

  const selectedFile = interaction.values[0];

  if (selectedFile === NEW_SESSION_SENTINEL) {
    await applyNewSession(interaction, interaction.channelId);
    return;
  }

  await applyResume(interaction, selectedFile);
}

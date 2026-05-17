import { randomUUID } from "node:crypto";
import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type RepliableInteraction,
} from "discord.js";
import { isAllowedUser } from "../../security/guard.js";
import { sessionManager } from "../../claude/session-manager.js";
import { upsertSession } from "../../db/database.js";
import { NEW_SESSION_SENTINEL } from "../commands/sessions.js";
import { L } from "../../utils/i18n.js";

async function applyResume(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  agentId: string,
): Promise<void> {
  upsertSession(randomUUID(), interaction.channelId, agentId, "idle");
  await interaction.update({
    embeds: [
      {
        title: L("Session Resumed", "세션 재개됨"),
        description: L(
          `Session: \`${agentId.slice(0, 12)}...\`\n\nNext message you send will resume this conversation.`,
          `세션: \`${agentId.slice(0, 12)}...\`\n\n다음 메시지부터 이 대화가 재개됩니다.`,
        ),
        color: 0x00ff00,
      },
    ],
    components: [],
  });
}

async function applyNewSession(
  interaction: RepliableInteraction & {
    update: ButtonInteraction["update"];
  },
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

  if (interaction.customId !== "session-select") return;

  const selectedAgentId = interaction.values[0];

  if (selectedAgentId === NEW_SESSION_SENTINEL) {
    await applyNewSession(interaction as any, interaction.channelId);
    return;
  }

  // Direct resume — no preview (Cursor SDK has no JSONL transcript access).
  await applyResume(interaction, selectedAgentId);
}

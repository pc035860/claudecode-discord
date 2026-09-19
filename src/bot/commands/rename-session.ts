import fs from "node:fs";
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import {
  createAgentSession,
  SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { getProject, getSession, upsertSession } from "../../db/database.js";
import {
  getPiModelRuntime,
  getResourceLoader,
  sessionManager,
} from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("rename-session")
  .setDescription("Rename the current channel's Pi agent session")
  .addStringOption((opt) =>
    opt.setName("name").setDescription("New session name").setRequired(true),
  );

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

  const name = interaction.options.getString("name", true).trim();
  if (!name) {
    await interaction.editReply({
      content: L("Name cannot be empty.", "이름을 입력하세요."),
    });
    return;
  }

  if (sessionManager.isActive(channelId)) {
    await interaction.editReply({
      content: L(
        "A task is running in this channel — stop it with `/stop` before renaming.",
        "이 채널에서 작업이 실행 중입니다 — `/stop`으로 중지한 뒤 이름을 변경하세요.",
      ),
    });
    return;
  }

  const dbSession = getSession(channelId);
  let sessionFile = dbSession?.pi_session_file ?? null;

  try {
    const cwd = fs.realpathSync(project.project_path);
    const runtime = await getPiModelRuntime();
    // Open the channel session if there is one, otherwise start a fresh
    // session file that the next message will continue.
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: runtime,
      resourceLoader: await getResourceLoader(cwd, project.output_style),
      sessionManager: sessionFile
        ? PiSessionManager.open(sessionFile)
        : PiSessionManager.create(cwd),
    });
    session.setSessionName(name);
    sessionFile = session.sessionFile ?? sessionFile;
    try {
      session.dispose();
    } catch {
      // ignore — dispose is best-effort listener cleanup
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await interaction.editReply({
      content: L(`Failed to rename session: ${msg}`, `세션 이름 변경에 실패했습니다: ${msg}`),
    });
    return;
  }

  upsertSession(dbSession?.id ?? randomUUID(), channelId, sessionFile, dbSession?.status ?? "idle");
  await interaction.editReply({
    content: L(
      `✅ Session renamed to \`${name}\`.`,
      `✅ 세션 이름이 \`${name}\`(으)로 변경되었습니다.`,
    ),
  });
}

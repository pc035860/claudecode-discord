// Live harness: drives the REAL SessionManager.sendMessage() with a fake
// Discord channel (real Pi API, real temp DB, real session files).
// Run from an EMPTY cwd so data.db lands in the sandbox, not the repo:
//   mkdir -p /tmp/pi-live && cd /tmp/pi-live && npx --prefix <repo> tsx <repo>/spike/live-harness.ts
import fs from "node:fs";
import path from "node:path";

process.env.DISCORD_BOT_TOKEN = "harness";
process.env.DISCORD_GUILD_ID = "harness-guild";
process.env.ALLOWED_USER_IDS = "harness-user";
process.env.BASE_PROJECT_DIR = "/tmp";
process.env.THREAD_PROGRESS = "false";
process.env.SHOW_COST = "true";

const repoRoot = "/Users/pc035860/code/claudecode-discord";
const { initDatabase, registerProject, getSession } = await import(
  `${repoRoot}/src/db/database.js`
);
const { sessionManager } = await import(
  `${repoRoot}/src/claude/session-manager.js`
);
const { SessionManager: PiSessions } = await import(
  "@earendil-works/pi-coding-agent"
);

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// Sandbox project with a file the agent can actually read.
const projDir = "/tmp/pi-live-proj";
fs.rmSync(projDir, { recursive: true, force: true });
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, "note.txt"), "the sky is blue\nsecond line\n");

initDatabase();
registerProject("live-ch", projDir, "harness-guild");

function fakeChannel(id: string) {
  const sent: any[] = [];
  const channel: any = {
    id,
    send: async (msg: any) => {
      sent.push(msg);
      return { edit: async () => {} };
    },
  };
  return { channel, sent };
}
const lastEmbed = (sent: any[]) =>
  [...sent].reverse().find((m) => m?.embeds?.length)?.embeds[0];

// 1. Fresh prompt: read a real file, expect result embed + nonzero cost.
{
  const { channel, sent } = fakeChannel("live-ch");
  await sessionManager.sendMessage(channel, "讀 note.txt，回報第一行是什麼（只回那一行）");
  const embed = lastEmbed(sent);
  const desc: string = embed?.description ?? embed?.data?.description ?? "";
  check("fresh: result embed sent", !!desc, JSON.stringify(desc).slice(0, 80));
  check("fresh: answer mentions sky", /sky is blue/i.test(desc));
  const footer: string = embed?.footer?.text ?? embed?.data?.footer?.text ?? "";
  const cost = parseFloat((footer.match(/\$([\d.]+)/) ?? [])[1] ?? "NaN");
  check("fresh: cost footer nonzero", Number.isFinite(cost) && cost > 0, footer);
  const db = getSession("live-ch");
  check("fresh: db idle + session file stored", db?.status === "idle" && !!db?.pi_session_file, db?.pi_session_file ?? "");
}

// 2. Resume: follow-up must recall turn 1 (history continuity).
{
  const { channel, sent } = fakeChannel("live-ch");
  await sessionManager.sendMessage(channel, "我剛叫你讀的檔案叫什麼名字？只回檔名");
  const embed = lastEmbed(sent);
  const desc: string = embed?.description ?? embed?.data?.description ?? "";
  check("resume: recalls note.txt", /note\.txt/i.test(desc), JSON.stringify(desc).slice(0, 80));
}

// 3. Stop mid-run: abort, no result embed, offline.
{
  const { channel, sent } = fakeChannel("live-ch");
  const flight = sessionManager.sendMessage(
    channel,
    "用 bash 列出 /usr/bin 底下每一個檔案並逐一用一句話介紹（長任務）",
  );
  await new Promise((r) => setTimeout(r, 3000));
  const stopped = await sessionManager.stopSession("live-ch");
  await flight;
  check("stop: stopSession true", stopped);
  check("stop: no result embed after abort", !lastEmbed(sent));
  check("stop: db offline", getSession("live-ch")?.status === "offline");
}

// 4. Rename + list + delete on the real session dir.
{
  const sessions = await PiSessions.list(fs.realpathSync(projDir));
  check("sessions: list finds live session", sessions.length >= 1, `count=${sessions.length}`);
  const target = sessions[0];
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const { session } = await createAgentSession({
    cwd: fs.realpathSync(projDir),
    sessionManager: PiSessions.open(target.path),
  } as any);
  session.setSessionName("live-harness-renamed");
  session.dispose();
  const relisted = await PiSessions.list(fs.realpathSync(projDir));
  check(
    "rename: name sticks without prompting",
    relisted.some((s) => s.name === "live-harness-renamed"),
  );
  fs.unlinkSync(target.path);
  const after = await PiSessions.list(fs.realpathSync(projDir));
  check("delete: file gone from list", !after.some((s) => s.path === target.path));
}

console.log(failures === 0 ? "\nALL LIVE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

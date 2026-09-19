// One-off: verify the persona reaches the agent's system prompt.
// Run from empty cwd: cd /tmp/pi-live2 && tsx <repo>/spike/persona-check.ts ; rm -rf /tmp/pi-live2
process.env.DISCORD_BOT_TOKEN = "harness";
process.env.DISCORD_GUILD_ID = "harness-guild";
process.env.ALLOWED_USER_IDS = "harness-user";
process.env.BASE_PROJECT_DIR = "/tmp";
process.env.THREAD_PROGRESS = "false";

import fs from "node:fs";
const repoRoot = "/Users/pc035860/code/claudecode-discord";
const { initDatabase, registerProject } = await import(`${repoRoot}/src/db/database.js`);
const sm = await import(`${repoRoot}/src/claude/session-manager.js`);

const persona = sm.loadPersonaText("seed");
console.log("persona loaded:", persona.length > 0, "| has 席德:", persona.includes("席德"));

const projDir = "/tmp/pi-live2-proj";
fs.rmSync(projDir, { recursive: true, force: true });
fs.mkdirSync(projDir, { recursive: true });
initDatabase();
registerProject("persona-ch", projDir, "harness-guild");

const sent: any[] = [];
const channel: any = {
  id: "persona-ch",
  send: async (m: any) => { sent.push(m); return { edit: async () => {} }; },
};
await sm.sessionManager.sendMessage(channel, "你是誰？用一句話介紹你自己就好");
const embed = [...sent].reverse().find((m) => m?.embeds?.length)?.embeds[0];
const desc = embed?.description ?? embed?.data?.description ?? "";
console.log("answer:", JSON.stringify(desc).slice(0, 120));
console.log(desc.includes("席德") ? "PERSONA CHECK PASSED" : "PERSONA CHECK FAILED");
process.exit(desc.includes("席德") ? 0 : 1);

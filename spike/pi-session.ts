import "dotenv/config";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

// Bot-side default model (independent of ~/.pi/agent/settings.json defaultModel).
// Format matches pi CLI --model: "provider/model-id[:thinkingLevel]"
const MODEL_SPEC =
  process.env.PI_MODEL ?? "openrouter/meta/muse-spark-1.3-contributor";
const cwd = process.cwd();

let failures = 0;
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  process.stdout.write(`\n[${label}] ... `);
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`OK (${Date.now() - t0}ms)`);
    return r;
  } catch (e: any) {
    failures++;
    console.log(`FAIL (${Date.now() - t0}ms)`);
    console.log("  name   :", e?.name);
    console.log("  message:", String(e?.message ?? e).slice(0, 500));
    return null;
  }
}

// 1. ModelRuntime picks up ~/.pi/agent/auth.json + models.json by default
const modelRuntime = await step("ModelRuntime.create()", () =>
  ModelRuntime.create(),
);
if (!modelRuntime) process.exit(1);

await step("checkAuth(openrouter)", async () => {
  const status = await modelRuntime.checkAuth("openrouter");
  console.log("\n  status:", JSON.stringify(status).slice(0, 200));
  return status;
});

await step("getAvailable() contains target", async () => {
  const available = await modelRuntime.getAvailable();
  const hit = available.find(
    (m: any) =>
      m.provider === "openrouter" &&
      m.id === "meta/muse-spark-1.3-contributor",
  );
  console.log(`\n  available total: ${available.length}, target found: ${!!hit}`);
  if (!hit) throw new Error("target model not in available list");
  return hit;
});

// 2. Resolve bot default model spec (incl. custom models from models.json)
const resolved = await step(`resolveCliModel(${MODEL_SPEC})`, async () => {
  const r = resolveCliModel({ cliModel: MODEL_SPEC, modelRuntime });
  if (r.error) throw new Error(r.error);
  if (r.warning) console.log("\n  warning:", r.warning);
  console.log(
    `\n  model: ${r.model?.id} [${(r.model as any)?.provider ?? "?"}] thinking=${r.thinkingLevel}`,
  );
  return r;
});
if (!resolved?.model) process.exit(1);
const botModel: any = resolved.model;
const botThinking = resolved.thinkingLevel;

// 3. Fresh session: subscribe events + prompt
const created = await step("createAgentSession(fresh)", () =>
  createAgentSession({
    cwd,
    model: botModel,
    thinkingLevel: botThinking as any,
    modelRuntime,
    sessionManager: SessionManager.create(cwd),
  }),
);
if (!created) process.exit(1);
const { session } = created;
console.log(`  sessionId: ${session.sessionId}`);
console.log(`  sessionFile: ${session.sessionFile}`);

const stats = { textChars: 0, toolStarts: 0, toolEnds: 0, agentEnds: 0 };
const unsub = session.subscribe((event: any) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent?.type === "text_delta"
  ) {
    stats.textChars += event.assistantMessageEvent.delta?.length ?? 0;
  } else if (event.type === "tool_execution_start") {
    stats.toolStarts++;
    console.log(`\n  [tool_start] ${event.toolName}`);
  } else if (event.type === "tool_execution_end") {
    stats.toolEnds++;
  } else if (event.type === "agent_end") {
    stats.agentEnds++;
  }
});

await step('prompt("回覆一個字：好")', () => session.prompt("回覆一個字：好"));
unsub();
console.log("  event stats:", JSON.stringify(stats));
const tail = session.messages.slice(-2).map((m: any) => ({
  role: m.role,
  text:
    typeof m.content === "string"
      ? m.content.slice(0, 120)
      : JSON.stringify(m.content).slice(0, 120),
}));
console.log("  tail messages:", JSON.stringify(tail, null, 1));
const sessionFile = session.sessionFile!;
session.dispose();

// 4. Resume via SessionManager.open(sessionFile), enforce bot default model
const reopened = await step("createAgentSession(open sessionFile)", () =>
  createAgentSession({
    cwd,
    model: botModel,
    thinkingLevel: botThinking as any,
    modelRuntime,
    sessionManager: SessionManager.open(sessionFile),
  }),
);
if (!reopened) process.exit(1);
const s2 = reopened.session;
console.log(`  resumed sessionId: ${s2.sessionId} (same=${s2.sessionId === session.sessionId})`);
console.log(`  resumed messages: ${s2.messages.length}`);

await step("setModel(bot default) + follow-up prompt", async () => {
  await s2.setModel(botModel);
  console.log(`\n  model after set: ${(s2.model as any)?.id}`);
  let chars = 0;
  const un2 = s2.subscribe((event: any) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      chars += event.assistantMessageEvent.delta?.length ?? 0;
    }
  });
  // Ask about the previous turn — proves history survived the resume.
  await s2.prompt("我上一句叫你回什麼？用同一個字回答就好");
  un2();
  console.log(`\n  follow-up text chars: ${chars}`);
});
s2.dispose();

console.log(failures === 0 ? "\nALL SPIKE STEPS PASSED" : `\n${failures} STEP(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

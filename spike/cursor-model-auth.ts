import "dotenv/config";
import { Agent } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) { console.error("CURSOR_API_KEY missing"); process.exit(1); }

const params = JSON.parse(process.env.CURSOR_MODEL_PARAMS ?? "[]");
const targets = process.argv.slice(2);
if (targets.length === 0) { console.error("usage: tsx spike/cursor-model-auth.ts <model-id>..."); process.exit(1); }

for (const id of targets) {
  const t0 = Date.now();
  process.stdout.write(`\n=== ${id} ===\n`);
  try {
    const agent = await Agent.create({
      apiKey,
      model: { id, params },
      local: { cwd: process.env.SPIKE_CWD ?? process.cwd(), settingSources: ["all"] },
    });
    const run = await agent.send("Reply with exactly: pong. Do not use any tools.");
    for await (const _ of run.stream()) { /* drain */ }
    const final = await run.wait();
    console.log(`status   : ${final.status}`);
    console.log(`result   : ${JSON.stringify(final.result)?.slice(0, 120)}`);
    console.log(`error    : ${JSON.stringify((final as any).error)}`);
    console.log(`durationMs: ${final.durationMs}  (wall ${Date.now() - t0}ms)`);
    agent.close?.();
  } catch (e: any) {
    console.log(`THREW ${e?.name} code=${e?.code} (wall ${Date.now() - t0}ms)`);
    console.log(`  ${e?.message}`);
  }
}

import "dotenv/config";
import { Agent } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY!;
const modelId = process.env.CURSOR_MODEL ?? "composer-2";
const targetCwd = process.argv[2];

if (!targetCwd) {
  console.error("usage: tsx cursor-cwd.ts <absolute-cwd>");
  process.exit(1);
}

console.log(`cwd=${targetCwd} model=${modelId}`);

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  process.stdout.write(`\n[${label}] ... `);
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`OK (${Date.now() - t0}ms)`);
    return r;
  } catch (e: any) {
    console.log(`FAIL (${Date.now() - t0}ms)`);
    console.log("  name   :", e?.name);
    console.log("  code   :", e?.code);
    console.log("  message:", e?.message);
    if (e?.details?.length) {
      for (const d of e.details) {
        console.log("  detail.type:", d.type);
        if (d.debug) console.log("  detail.debug:", JSON.stringify(d.debug));
      }
    }
    return null;
  }
}

const agent = await step("Agent.create", () =>
  Agent.create({
    apiKey,
    model: { id: modelId },
    local: { cwd: targetCwd, settingSources: ["all"] },
  }),
);

if (agent) {
  console.log(`  -> agentId: ${agent.agentId}`);

  const run = await step("send ping", () => agent.send("ping"));

  if (run) {
    await step("stream drain", async () => {
      let n = 0;
      for await (const ev of run.stream()) {
        n++;
        if (n <= 3) console.log(`    ev[${n}]: ${(ev as any).type}`);
      }
      return n;
    });

    await step("run.wait", () => run.wait());
  }
}

console.log("\ndone");

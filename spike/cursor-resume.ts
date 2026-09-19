import "dotenv/config";
import { Agent } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY!;
const cwd = process.cwd();
const modelId = process.env.CURSOR_MODEL ?? "composer-2";

const candidates = [
  ["bogus (random uuid)", "agent-00000000-0000-0000-0000-000000000000"],
  ["3d old", "agent-a7fc100a-a2cf-4ba9-8dc0-8796040a6638"],
  ["recent (16:07)", "agent-f537a8b2-ca77-4af2-90aa-0e9a9e9465d3"],
  ["recent (16:07) #2", "agent-8c431167-90f0-4eea-9cf5-509075c1b0c0"],
];

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

for (const [label, id] of candidates) {
  const agent = await step(`resume ${label}`, () =>
    Agent.resume(id, {
      apiKey,
      model: { id: modelId },
      local: { cwd, settingSources: ["all"] },
    }),
  );

  if (agent) {
    const run = await step(`  send ping on ${label}`, () =>
      agent.send("ping"),
    );

    if (run) {
      await step(`  stream drain ${label}`, async () => {
        let n = 0;
        for await (const _ev of run.stream()) {
          n++;
          if (n >= 3) break;
        }
        return n;
      });
    }
  }
}

console.log("\ndone");

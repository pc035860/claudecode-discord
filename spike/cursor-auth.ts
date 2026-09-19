import "dotenv/config";
import { Agent, Cursor } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
const model = process.env.CURSOR_MODEL ?? "composer-2";

if (!apiKey) {
  console.error("CURSOR_API_KEY missing");
  process.exit(1);
}

console.log(
  `key prefix=${apiKey.slice(0, 8)} len=${apiKey.length} model=${model}`,
);

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
    if (e?.metadata?.get) {
      console.log("  date hdr:", e.metadata.get("date"));
      console.log("  request-id:", e.metadata.get("x-request-id"));
    }
    if (e?.details) {
      for (const d of e.details) {
        console.log("  detail.type:", d.type);
        if (d.debug) console.log("  detail.debug:", JSON.stringify(d.debug));
      }
    }
    return null;
  }
}

const models = await step("Cursor.models.list", () =>
  Cursor.models.list({ apiKey }),
);
if (models) console.log(`  -> ${models.length} models available`);

const agent = await step("Agent.create", () =>
  Agent.create({
    apiKey,
    model: { id: model },
    local: { cwd: process.cwd(), settingSources: ["all"] },
  }),
);

if (agent) {
  console.log(`  -> agent id: ${(agent as any).id ?? "(no id field)"}`);

  const run = await step("agent.send('ping')", () => agent.send("ping"));

  if (run) {
    await step("run.stream() drain", async () => {
      let count = 0;
      for await (const ev of run.stream()) {
        count++;
        if (count <= 3) console.log(`    ev[${count}]: ${ev.type}`);
      }
      return count;
    });

    await step("run.wait()", () => run.wait());
  }
}

console.log("\ndone");

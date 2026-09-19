import "dotenv/config";
import { inspect } from "node:util";
import { Agent } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY!;
const cwd = process.cwd();
const goodModel = process.env.CURSOR_MODEL ?? "composer-2";

function dump(label: string, obj: unknown) {
  console.log(`\n--- ${label} ---`);
  if (obj && typeof obj === "object") {
    const ownProps = Object.getOwnPropertyNames(obj);
    console.log("ownPropertyNames:", ownProps);
    const proto = Object.getPrototypeOf(obj);
    if (proto && proto !== Object.prototype) {
      console.log("prototype ownNames:", Object.getOwnPropertyNames(proto));
      console.log("prototype.constructor.name:", proto.constructor?.name);
    }
    console.log("JSON.stringify:", JSON.stringify(obj, null, 2));
    console.log("util.inspect (showHidden, depth=3):");
    console.log(inspect(obj, { showHidden: true, depth: 3, colors: false }));
  } else {
    console.log("value:", obj);
  }
}

async function trial(label: string, build: () => Promise<Agent>, prompt = "say hi briefly") {
  console.log(`\n========== TRIAL: ${label} ==========`);
  let agent: Agent | null = null;
  try {
    agent = await build();
    console.log(`agent built: id=${(agent as any).id ?? "?"}`);
  } catch (e: any) {
    console.log(`build FAIL: name=${e?.name} code=${e?.code} message=${e?.message}`);
    return;
  }

  let run: any = null;
  try {
    run = await agent.send(prompt);
    console.log(`run sent: id=${run.id} agentId=${run.agentId}`);
  } catch (e: any) {
    console.log(`send FAIL: name=${e?.name} code=${e?.code} message=${e?.message}`);
    return;
  }

  const statusLog: string[] = [];
  if (typeof run.onDidChangeStatus === "function") {
    run.onDidChangeStatus((s: string) => statusLog.push(s));
  }

  try {
    let n = 0;
    for await (const ev of run.stream()) {
      n++;
      if (n <= 5) console.log(`  stream[${n}].type=${ev.type}`);
      if (n >= 40) break;
    }
    console.log(`  stream drained: ${n} events`);
  } catch (e: any) {
    console.log(`stream FAIL: name=${e?.name} code=${e?.code} message=${e?.message}`);
  }

  try {
    const final = await run.wait();
    console.log(`wait returned. status=${final.status} durationMs=${final.durationMs} result=${JSON.stringify(final.result)}`);
    dump(`final (wait result) for ${label}`, final);
  } catch (e: any) {
    console.log(`wait FAIL: name=${e?.name} code=${e?.code} message=${e?.message}`);
    dump(`wait threw for ${label}`, e);
  }

  console.log(`onDidChangeStatus log: ${JSON.stringify(statusLog)}`);
  console.log(`run.status (readonly accessor): ${run.status}`);
  console.log(`run.result (readonly accessor): ${JSON.stringify(run.result)}`);
}

await trial("baseline (good model, normal prompt)", () =>
  Agent.create({
    apiKey,
    model: { id: goodModel },
    local: { cwd, settingSources: ["all"] },
  }),
);

await trial(
  "bogus model id",
  () =>
    Agent.create({
      apiKey,
      model: { id: "definitely-not-a-real-model-xyz" } as any,
      local: { cwd, settingSources: ["all"] },
    }),
);

await trial(
  "valid model + huge prompt (try to trip server)",
  () =>
    Agent.create({
      apiKey,
      model: { id: goodModel },
      local: { cwd, settingSources: ["all"] },
    }),
  "x".repeat(200_000),
);

console.log("\nspike done");

import { Agent } from "@cursor/sdk";

const agentId = process.argv[2];
const modelId = process.argv[3] ?? "grok-4.5";
const params =
  modelId === "grok-4.5"
    ? [
        { id: "effort", value: "medium" },
        { id: "fast", value: "false" },
      ]
    : [{ id: "fast", value: "false" }];

const agent = await Agent.resume(agentId, {
  apiKey: process.env.CURSOR_API_KEY,
  model: { id: modelId, params },
  local: { cwd: "/Users/pc035860/code/claude-md", settingSources: ["all"] },
});

const run = await agent.send(process.argv[4] ?? "回覆一個字：好", { local: { force: true } });
for await (const ev of run.stream()) {
  if (ev.type === "tool_call") console.log("[tool]", ev.name, ev.status);
}
const final = await run.wait();
console.log(
  JSON.stringify(
    {
      model: modelId,
      status: final.status,
      result: final.result?.slice(0, 200),
      durationMs: final.durationMs,
    },
    null,
    2,
  ),
);
agent.close();
process.exit(0);

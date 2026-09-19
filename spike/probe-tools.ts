import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader, getAgentDir, resolveCliModel } from "@earendil-works/pi-coding-agent";
const cwd = "/tmp/pi-probe-proj";
const { mkdirSync, rmSync } = await import("node:fs");
rmSync(cwd, { recursive: true, force: true }); mkdirSync(cwd, { recursive: true });
const runtime = await ModelRuntime.create();
const resolved = resolveCliModel({ cliModel: "openrouter/meta/muse-spark-1.3-contributor:medium", modelRuntime: runtime });
const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
await loader.reload();
const { session } = await createAgentSession({ cwd, model: resolved.model!, thinkingLevel: "medium" as any, modelRuntime: runtime, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
session.subscribe((e: any) => {
  if (e.type === "tool_execution_start") {
    console.log(`### ${e.toolName} :: ${JSON.stringify(e.args).slice(0, 400)}`);
  }
});
await session.prompt("用 todo 建一個測試任務、用 graph-memory 搜尋 nodes 主題 Ruru，然後回一句完成就好");
session.dispose();
process.exit(0);

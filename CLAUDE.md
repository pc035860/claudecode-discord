# CLAUDE.md - claudecode-discord

> Migrated from `@cursor/sdk` to `@earendil-works/pi-coding-agent` (^0.85.1). Discord bot now drives local Pi coding agents in-process. Node ≥ 22 required.

## 啟動方式

不使用原本的 `mac-start.sh`，改用 PM2 管理：

```bash
# 首次註冊
npm run build
pm2 start dist/index.js --name claudecode-discord
pm2 save

# 日常操作
pm2 restart claudecode-discord   # 重啟（程式碼變動）
pm2 logs claudecode-discord      # 看 log
pm2 stop claudecode-discord      # 停止
```

修改程式碼後需要重新 build 再重啟：

```bash
npm run build && pm2 restart claudecode-discord
```

**環境變數變動時** 用 `pm2 delete + start`（`pm2 restart` 不會 reload `.env`），且下指令的 shell 必須沒有 export 同名變數（`env -u PI_MODEL pm2 start ...`）：pm2 會把 CLI shell 的 env 繼承給子行程，而 dotenv 不覆蓋已存在的變數——shell 裡 export 過的舊值會讓 `.env` 被無聲無視（2026-09-19 實測：改 `.env` 後 boot 仍是舊模型）。改完用 `pm2 logs` 確認 `Bot model resolved` 行：

```bash
env -u PI_MODEL pm2 delete claudecode-discord
env -u PI_MODEL pm2 start dist/index.js --name claudecode-discord
pm2 save
```

> Pi 版不再需要 `--cron-restart`（Cursor 時代用來重置爛掉的 SDK client state，本地引擎無此問題）。

## 設定文件

- macOS / Linux 設定：`SETUP.md`
- Windows 設定：`docs/SETUP-WINDOWS.md`

## 必要環境變數

- `PI_MODEL`（選用，預設 `accounts/fireworks/models/glm-5p3-flash:medium` — pi CLI 格式 `provider/id[:thinkingLevel]`，`:level` 必帶否則 fallback 到 `~/.pi/agent/settings.json` 的 defaultThinkingLevel）
- Auth 不走 env：`ModelRuntime.create()` 預設讀 `~/.pi/agent/auth.json` + `models.json`

## Bot Commands

主要 slash commands (src/bot/commands/)：
- `/new-session` — 快速建立新 Pi agent session
- `/sessions` — 列出／resume／刪除該專案的 Pi sessions（含預覽：name + firstMessage + messageCount）
- `/rename-session <name>` — 改名（`session.setSessionName()`）
- `/register <path>` — 註冊 channel 到專案目錄
- `/stop` — 停止當前 run（`session.abort()`）
- `/status` — 列出所有頻道狀態
- `/queue` — 管理排隊訊息
- `/models` — 列出可用模型（`modelRuntime.getAvailable()`，只顯示有認證的 provider）
- `/usage` — Claude Code 配額顯示（與本 bot SDK 無關，獨立 OAuth）

## Pi SDK 整合

`src/claude/session-manager.ts` 是核心：

```typescript
const runtime = await ModelRuntime.create(); // ~/.pi/agent/auth.json + models.json
const { model, thinkingLevel } = resolveCliModel({ cliModel: config.PI_MODEL, modelRuntime });
const { session } = await createAgentSession({
  cwd, model, thinkingLevel, modelRuntime,
  // 不傳 tools：跟 pi CLI 拿完整工具集（built-ins + extensions + MCP）
  resourceLoader, // DefaultResourceLoader + append(BOT.md + persona)
  sessionManager: resumeFile ? SessionManager.open(resumeFile) : SessionManager.create(cwd),
});
if (resumeFile) await session.setModel(model); // resume 一律釘回 bot 預設 model
session.subscribe((event) => { /* message_update / tool_execution_start */ });
await session.prompt(prompt);
```

- 一步 API：`createAgentSession()` → `session.subscribe()` → `await session.prompt()`
- 中斷用 `session.abort()`；prompt 被 abort 會 reject，靠 `cancelRequested` flag 區分 user-stop vs 真錯誤
- Session 檔是 JSONL，落在 `~/.pi/agent/sessions/--<cwd編碼>--/`；DB `sessions.pi_session_file` 欄存路徑（legacy `session_id`、`agent_id` 保留但不再使用）
- `ModelRuntime` / bot model / per-cwd loader 是 process-wide 單例（module-scope cache）
- 跑完一定要 `session.dispose()`（listener 清理）；下次訊息重新 open 檔案即可

## 功能狀態（Pi 版）

Pi 版恢復了 Cursor MVP 砍掉的三項：`/rename-session`（`setSessionName`）、`/sessions` 預覽 + Delete（`SessionInfo` 自帶 firstMessage/messageCount，刪除即 unlink）、cost 顯示（`getSessionStats().cost` 真實金額）。

仍維持修剪：
- ❌ Per-tool 互動式核准 — 走 full-allow（但 SDK 的 extension `tool_call` event 有 `{ block, reason }` hook，未來可用 `extensionFactories` 接 tool-gating）
- ❌ `/auto-approve` 指令、AskUserQuestion 互動 UI
- ❌ `/last`、`/clear-sessions`、`/output-styles` 指令

## 附件上傳功能

**Inbound**：使用者在 Discord 上傳的檔案會自動下載到 `<project>/.claude-uploads/`，並在 prompt 前綴 `[Attached images/files]` 提示 agent 用 `read` 工具讀取。

- 相關程式碼：`src/bot/handlers/message.ts`（`downloadAttachment`）
- Bot 需要 Discord `Attach Files` 權限（見 SETUP.md）

**Outbound `[ATTACH:]`**：agent 可在回應中寫 `[ATTACH: /絕對路徑]` 把產出的圖／檔送回 Discord。
- 指令注入：`rules/BOT.md` 在 module load 讀進 `BOT_RULES` 常數，經 `DefaultResourceLoader` 的 `systemPromptOverride` 注入（fresh + resume 全覆蓋，不再 prepend 到 prompt）。
- 解析：`extractAttachments()` 在 `run.wait()` 後從最終文字撈路徑、產出 cleanText。
- 上傳：`sendAttachments()` 在 result embed 前送出，含 whitelist（`/tmp`、`/private/tmp`、`project_path`，`fs.realpathSync` 防 symlink escape）+ dedupe + 10 個上限。
- 相關程式碼：`src/claude/output-formatter.ts`、`src/claude/session-manager.ts`、`rules/BOT.md`

## Thread Progress（討論串進度）

設定 `THREAD_PROGRESS=true` 後，Bot 在 Thinking 訊息上開 Discord thread，輸出工具呼叫和 assistant 文字。Thread lazy creation。

- 相關程式碼：`src/claude/thread-reporter.ts`（`ThreadReporter` class）
- **文字來源**：`message_update` events 的 `text_delta`
- **工具來源**：`tool_execution_start` events（含 `args`；end/update 階段目前忽略避免重複）
- 工具：不過濾，loader 發現的全部啟用（built-ins + extensions + MCP，跟 pi CLI 一致）。`TOOL_LABELS` 沒列名的工具顯示 `Using <name>` fallback
- 事件每 5 秒 batch flush，連續 text delta 會合併成一條 `💬` 訊息
- 文字合併（coalescing）：連續純文字 flush 會用 `Message.edit()` 合併到前一條 Discord 訊息

## Cost 顯示

`session.getSessionStats()` 回傳 `{ tokens, cost }` 真實金額，`SHOW_COST=true` 時 footer 顯示 session 累計 cost（注意是該 session 累計，不是單則訊息）。`SHOW_COST=false` 完全隱藏。

## Gotchas（改動前先讀）

- **Stop race + placeholder pattern** (`session-manager.ts`)：`sendMessage()` 在 `await createAgentSession()` 前就把一個 `placeholder` 寫進 `this.sessions` map（`session` 暫為 null）。`stopSession()` 設 `cancelRequested` flag，session 還沒備好就只翻 flag、sendMessage 每個 await 後檢查 flag 並 bail。`finally` 用 `this.sessions.get(channelId) === placeholder` identity-check 才 delete，避免 stop+新訊息把新 placeholder 刪掉。改動 ActiveSession 狀態時要保留這四點。
- **better-sqlite3 要 v12（Node 24）**：v11 在 Node 24 下會 `Statement` GC assertion crash 直接殺掉行程（2026-09-19 production 實測）。`package.json` 已升 `^12`，降 Node 或碰 sqlite 版本時注意這條。
- **system prompt 用 append 不用 replace**：`systemPromptOverride` 會蓋掉 Pi custom slot，一律走 `appendSystemPromptOverride`（BOT.md + persona）。Persona 來自 `projects.output_style`（預設 `seed`，讀 `rules/output-styles/<name>.md`），loader 按 `(cwd, style)` cache — 同專案不同 channel 不同 persona 才不會打架。
- **`SessionManager.list(cwd)` 原生 project-scope**：session 檔按 cwd 分桶（`~/.pi/agent/sessions/--<cwd編碼>--/`），`list()` 只讀該桶，不會跨專案。傳入前先 `fs.realpathSync()` 正規化 cwd — symlink 路徑（macOS `/tmp` vs `/private/tmp`）會編碼成不同桶名。
- **`L()` 每次都讀 `.tray-lang`**：不可把 `L(en, kr)` 結果 cache 進 module-scope 常數（會凍結語言）。`TOOL_LABELS` 用 `() => L(...)` thunks 就是這原因。
- **DB schema 演進**：用 `ALTER TABLE ... ADD COLUMN`（try-catch on duplicate column），不要砍 column（legacy `session_id`、`auto_approve`、`output_style` 都保留）。
- **`prompt()` abort 會 reject**：`/stop` 調 `session.abort()` 後 in-flight 的 `prompt()` 拋錯，靠 `cancelRequested` 區分 user-stop（跳過 result embed，維持 offline）vs 真錯誤（❌ + offline）。漏判會把 cancelled 寫成 idle 蓋掉 stop。
- **tsup 打包成單檔 → module 相對路徑深度不同**：`src/claude/foo.ts` 在 dev 跑（tsx）時 `import.meta.url` 指 `src/claude/`，但 prod 全部 bundle 到 `dist/index.js`（flat）。要讀 repo 相對檔（`rules/BOT.md`、`.tray-lang` …）必須 try 多個候選深度（`../../X` 給 tsx，`../X` 給 dist），別只寫一個就 ship。可參考 `BOT_RULES` IIFE（`session-manager.ts`）。
- **`realpathSync` 結果要往下游傳**：用 realpath 解析 + allowlist 檢查通過後，後續 `fs.existsSync` / `new AttachmentBuilder(...)` 都要用 **resolved 路徑**而不是原始輸入，否則 symlink 在驗證和讀取之間被換掉就會繞過 allowlist。`resolveIfAllowed` 回傳 `string | null` 就是強制這個 contract（`output-formatter.ts`）。
- **PI_MODEL 一定要帶 `:level`**：`resolveCliModel()` 無 suffix 時回傳 `thinkingLevel=undefined`，session 會 fallback 到使用者 `settings.json` 的 defaultThinkingLevel，bot 行為被本機設定綁住。預設值寫死 `:medium` 就是防這個。
- **resume 一律 `setModel(botModel)`**：session 檔可能記著本機 pi CLI 跑過的別顆 model，不釘回來計費跟行為都不固定（spike 已驗證）。
- **`AgentMessage` 沒 export**：SDK 不 export 該型別，最終文字提取走結構型別（`extractAssistantText`，已 export、可單測）。

## Migration history

從 Claude Agent SDK 遷移到 Cursor SDK 的完整 plan + 決策紀錄：
`specs/plan/plan-2026-05-17_16-25-36_cursor-sdk-migration_fbb7d013-38f.md`

從 Cursor SDK 遷移到 Pi Agent SDK 的 plan + spike：
`specs/plan/plan-2026-09-19_10-30-00_pi-sdk-migration.md`、`spike/pi-session.ts`

## 測試

Vitest v2.0.0，測試檔案與原始碼共置（`*.test.ts`）。

```bash
npm test              # vitest run（單次）
npm run test:watch    # vitest（監視模式）
```

- `formatToolDetail`、`parseApiError`、`extractAssistantText` 是從 `session-manager.ts` 提取出的 exported pure functions
- `ThreadReporter` 測試用 `vi.useFakeTimers()`，async flush 需搭配 `Promise.resolve()` yield
- `config.test.ts` 每個 test case 都需要 `vi.resetModules()` + dynamic import（因 `_config` 快取）
- Pi SDK 在測試中 mock：`vi.mock("@earendil-works/pi-coding-agent", ...)`（`createAgentSession`、`ModelRuntime`、`SessionManager`、`resolveCliModel`、`DefaultResourceLoader`、`getAgentDir`）

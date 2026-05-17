# CLAUDE.md - claudecode-discord

> Migrated from `@anthropic-ai/claude-agent-sdk` to `@cursor/sdk` (~1.0.13). Discord bot now drives Cursor agents instead of Claude Code. Node ≥ 22 required.

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

**環境變數變動時** 用 `pm2 delete + start`（`pm2 restart` 不會 reload `.env`）：

```bash
pm2 delete claudecode-discord
pm2 start dist/index.js --name claudecode-discord
pm2 save
```

## 設定文件

- macOS / Linux 設定：`SETUP.md`
- Windows 設定：`docs/SETUP-WINDOWS.md`

## 必要環境變數

- `CURSOR_API_KEY` — Cursor SDK API key（從 Cursor Dashboard → Integrations 取得）
- `CURSOR_MODEL`（選用，預設 `composer-2-fast`）
- `CURSOR_MODEL_PARAMS`（選用，JSON array of `{id,value}`，例：`[{"id":"thinking","value":"high"}]`）

## Bot Commands

主要 slash commands (src/bot/commands/)：
- `/new-session` — 快速建立新 Cursor agent session
- `/sessions` — 列出並 resume 現有 Cursor agents（resume-only，不支援預覽 / 刪除）
- `/register <path>` — 註冊 channel 到專案目錄
- `/stop` — 停止當前 run（`run.cancel()`）
- `/status` — 列出所有頻道狀態
- `/queue` — 管理排隊訊息
- `/cursor-models` — 列出可用的 Cursor SDK 模型（呼叫 `Cursor.models.list()`）
- `/usage` — Claude Code 配額顯示（與本 bot SDK 無關，獨立 OAuth）

## Cursor SDK 整合

`src/claude/session-manager.ts` 是核心：

```typescript
const agent = resumeAgentId
  ? await Agent.resume(resumeAgentId, { apiKey, local: { cwd, settingSources: ["all"] } })
  : await Agent.create({
      apiKey: config.CURSOR_API_KEY,
      model: { id: config.CURSOR_MODEL, params: config.CURSOR_MODEL_PARAMS },
      local: { cwd: project.project_path, settingSources: ["all"] },
    });
const run = await agent.send(prompt);
for await (const event of run.stream()) { /* ... */ }
const result = await run.wait();
```

- 兩步驟 API：`Agent.create()` → `agent.send()` → `run.stream()`
- 中斷用 `run.cancel()`（取代舊的 `queryInstance.interrupt()`）
- `local.settingSources: ["all"]` 載入 Cursor 全部設定層（user/project/team/mdm/plugins）
- Agent id 儲存到 DB `sessions.agent_id` 欄位（legacy `session_id` 欄保留但不再使用）

## MVP 階段砍掉的功能

對齊 Cursor SDK missing primitives，MVP 砍掉：
- ❌ Per-tool 互動式核准（Cursor 沒有 `canUseTool` callback）— 走 full-allow
- ❌ `/auto-approve` 指令、AskUserQuestion 互動 UI
- ❌ `/rename-session` 指令（Cursor SDK 無 rename API）
- ❌ `/last`、`/clear-sessions` 指令（依賴 Claude JSONL on-disk）
- ❌ `/output-styles` 指令、`rules/BOT.md` 注入（Cursor 沒有 `systemPrompt.append`）
- ❌ `/sessions` 預覽 + Delete 按鈕（Cursor SQLite-backed，無 JSONL）
- ❌ `[ATTACH:]` outbound 標記（Cursor 不認識此慣例）

未來若要重接：tool-gating 可走 `.cursor/hooks.json` 或 `permissions.json`；persona 注入可考慮 `AGENTS.md` 或 prepend prompt。

## 附件上傳功能（inbound）

使用者在 Discord 上傳的檔案會自動下載到 `<project>/.claude-uploads/`，並在 prompt 前綴 `[Attached images/files]` 提示 Cursor 用 `read` 工具讀取。這個 inbound 流程 **保留**；outbound `[ATTACH:]` 已停用。

- 相關程式碼：`src/bot/handlers/message.ts`（`downloadAttachment`）
- Bot 仍需要 Discord `Attach Files` 權限（見 SETUP.md）

## Thread Progress（討論串進度）

設定 `THREAD_PROGRESS=true` 後，Bot 在 Thinking 訊息上開 Discord thread，輸出工具呼叫和 assistant 文字。Thread lazy creation。

- 相關程式碼：`src/claude/thread-reporter.ts`（`ThreadReporter` class）
- **文字來源**：Cursor `assistant` events 的 `TextBlock`
- **工具來源**：Cursor `tool_call` events（`status: "running"` 階段；completed/error 階段目前忽略避免重複）
- Cursor 工具名：`shell, read, write, edit, ls, glob, grep, semSearch, task, mcp`
- 事件每 5 秒 batch flush，連續 text delta 會合併成一條 `💬` 訊息
- 文字合併（coalescing）：連續純文字 flush 會用 `Message.edit()` 合併到前一條 Discord 訊息

## Cost 顯示

Cursor SDK 的 `RunResult` 目前不提供 cost。`SHOW_COST=true` 時 footer 會顯示 `$0.0000`。`SHOW_COST=false` 完全隱藏。

## Gotchas（改動前先讀）

- **Stop race + placeholder pattern** (`session-manager.ts`)：`sendMessage()` 在 `await Agent.create()` / `await agent.send()` 前就把一個 `placeholder` 寫進 `this.sessions` map（`agent`/`run` 暫為 null）。`stopSession()` 設 `cancelRequested` flag，run 還沒備好就只翻 flag、sendMessage 每個 await 後檢查 flag 並 bail。`finally` 用 `this.sessions.get(channelId) === placeholder` identity-check 才 delete，避免 stop+新訊息把新 placeholder 刪掉。改動 ActiveSession 狀態時要保留這四點。
- **`Agent.list({ cwd })` 不能 project-scope**：Cursor SDK 把 `cwd` 當 platform workspaceRef，不是 per-run `local.cwd`。`/sessions` 列的是 bot workspace 內所有 agents，跨專案 agents 也會出現。不要試圖用 `info.cwd === projectPath` filter（會把自己建的 agents 全濾掉）。
- **`L()` 每次都讀 `.tray-lang`**：不可把 `L(en, kr)` 結果 cache 進 module-scope 常數（會凍結語言）。`TOOL_LABELS` 用 `() => L(...)` thunks 就是這原因。
- **DB schema 演進**：用 `ALTER TABLE ... ADD COLUMN`（try-catch on duplicate column），不要砍 column（legacy `session_id`、`auto_approve`、`output_style` 都保留）。
- **`run.wait()` 要分流 status**：`cancelled` 跳過 result embed（讓 `/stop` 的 offline 維持），`error` 顯示 ❌ + offline，其他才走 success path。漏判會把 cancelled 寫成 idle 蓋掉 stop。

## Migration history

從 Claude Agent SDK 遷移到 Cursor SDK 的完整 plan + 決策紀錄：
`specs/plan/plan-2026-05-17_16-25-36_cursor-sdk-migration_fbb7d013-38f.md`

## 測試

Vitest v2.0.0，測試檔案與原始碼共置（`*.test.ts`）。

```bash
npm test              # vitest run（單次）
npm run test:watch    # vitest（監視模式）
```

- `formatToolDetail` 和 `parseApiError` 是從 `session-manager.ts` 提取出的 exported pure functions
- `ThreadReporter` 測試用 `vi.useFakeTimers()`，async flush 需搭配 `Promise.resolve()` yield
- `config.test.ts` 每個 test case 都需要 `vi.resetModules()` + dynamic import（因 `_config` 快取）
- Cursor SDK 在測試中 mock：`vi.mock("@cursor/sdk", () => ({ Agent: { create, resume, list } }))`

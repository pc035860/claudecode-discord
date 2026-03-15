# CLAUDE.md - claudecode-discord

## 啟動方式

不使用原本的 `mac-start.sh`，改用 PM2 管理：

```bash
pm2 restart claudecode-discord   # 重啟
pm2 logs claudecode-discord      # 看 log
pm2 stop claudecode-discord      # 停止
```

修改程式碼後需要重新 build 再重啟：

```bash
npm run build && pm2 restart claudecode-discord
```

> **重要**：`pm2 restart` 可以在 Claude Code 內執行，不會汙染環境變數。
> PM2 儲存的是初次 `pm2 start` 時的環境，restart 不會繼承當前 shell 的 env。
> 但 **`pm2 start`（首次註冊）必須在 Claude Code 外的 terminal 執行**，
> 否則 `CLAUDECODE=1` 會被存入 PM2，導致 SDK 拒絕啟動 nested session。

## 設定文件

- macOS / Linux 設定：`SETUP.md`
- Windows 設定：`docs/SETUP-WINDOWS.md`

## Bot Commands

主要 slash commands (src/bot/commands/):
- `/new-session` - 快速建立新 Claude Code session
- `/sessions` - 列出並切換現有 sessions
- `/register <path>` - 註冊 channel 到專案目錄
- `/stop` - 停止當前 session
- `/auto-approve <mode>` - 設定工具自動核准模式

## Bot 行為規則（bot-rules.md）

在專案根目錄放置 `bot-rules.md`，內容會透過 `systemPrompt.append` 注入到每個 Claude session。不需重啟 bot 即可更新規則（每次 session 啟動時重新讀取）。檔案不存在時優雅降級，行為與原本相同。

## 附件上傳功能

Claude 可在回應中用 `[ATTACH: /絕對路徑/檔案]` 標記檔案，Bot 會自動解析並上傳到 Discord。

- 安全限制：只允許專案目錄和 `/tmp` 內的檔案（含 symlink 解析）
- 上限 10 個附件，自動去重、批次發送
- 相關程式碼：`output-formatter.ts`（`extractAttachments` / `sendAttachments`）
- Bot 需要 Discord `Attach Files` 權限（見 SETUP.md）
- 標記說明寫在 `bot-rules.md`，Claude 每次 session 啟動時讀取

## Thread Progress（討論串進度）

設定 `THREAD_PROGRESS=true` 後，Bot 會在 Thinking 訊息上開 Discord thread，持續輸出工具呼叫和 assistant 文字的中間過程。Thread 採用 lazy creation：只有在第一次有實際內容要輸出時才會建立，避免簡單對話產生空 thread。

- 相關程式碼：`thread-reporter.ts`（`ThreadReporter` class）
- **文字來源**：SDK `stream_event`（`content_block_delta` → `text_delta`），非完整 `assistant` 訊息
- **工具來源**：SDK `stream_event`（`content_block_start/delta/stop` → `tool_use`），涵蓋所有工具（含 SDK 內部自動允許的 Agent、Task 等）
- `canUseTool` 只負責推送 `❌ denied` 和 `⏱️ timed out` 狀態標記
- 事件每 5 秒 batch flush，連續 text delta 會合併成一條 `💬` 訊息
- **文字合併（coalescing）**：連續的純文字 flush 會用 `Message.edit()` 合併到前一條 Discord 訊息，而非每次都送新訊息。遇到工具事件、超過 `MAX_DISCORD_LENGTH`、或 edit 失敗時 fallback 為 send
- Agent tool 顯示 `[subagent_type] description`，TaskUpdate 顯示 `#id → status`

## 注意：settingSources 修改

`src/claude/session-manager.ts` 中的 `query()` 呼叫有加入以下設定，讓 Claude 能讀取 user 和 project 層級的 CLAUDE.md：

```typescript
systemPrompt: { type: "preset", preset: "claude_code" },
settingSources: ["user", "project"],
```

原始碼預設不載入任何 filesystem 設定（`settingSources` 預設為 `[]`），需要明確指定才會生效。

## 測試

Vitest v2.0.0，測試檔案與原始碼共置（`*.test.ts`）。

```bash
npm test              # vitest run（單次）
npm run test:watch    # vitest（監視模式）
```

- `formatToolDetail` 和 `parseApiError` 是從 `session-manager.ts` 提取出的 exported pure functions，方便單獨測試
- `sendAttachments` 測試需 mock `fs.realpathSync`（macOS `/tmp` → `/private/tmp` symlink 問題），用 `vi.spyOn` 不用 `vi.mock`
- `ThreadReporter` 測試用 `vi.useFakeTimers()`，注意 async flush 需搭配 `Promise.resolve()` yield
- `ThreadReporter` mock 的 `threadSend` 和 `threadEdit` 都需回傳 `{ edit: threadEdit }`，因為 `doFlush()` 會存 send/edit 的回傳值作為 `lastTextMessage`
- `config.test.ts` 每個 test case 都需要 `vi.resetModules()` + dynamic import（因 `_config` 快取）

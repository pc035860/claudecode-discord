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

## Bot Commands

主要 slash commands (src/bot/commands/):
- `/new-session` - 快速建立新 Claude Code session
- `/sessions` - 列出並切換現有 sessions
- `/register <path>` - 註冊 channel 到專案目錄
- `/stop` - 停止當前 session
- `/auto-approve <mode>` - 設定工具自動核准模式

## 注意：settingSources 修改

`src/claude/session-manager.ts` 中的 `query()` 呼叫有加入以下設定，讓 Claude 能讀取 user 和 project 層級的 CLAUDE.md：

```typescript
systemPrompt: { type: "preset", preset: "claude_code" },
settingSources: ["user", "project"],
```

原始碼預設不載入任何 filesystem 設定（`settingSources` 預設為 `[]`），需要明確指定才會生效。

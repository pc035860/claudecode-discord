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

## 注意：settingSources 修改

`src/claude/session-manager.ts` 中的 `query()` 呼叫有加入以下設定，讓 Claude 能讀取 user 和 project 層級的 CLAUDE.md：

```typescript
systemPrompt: { type: "preset", preset: "claude_code" },
settingSources: ["user", "project"],
```

原始碼預設不載入任何 filesystem 設定（`settingSources` 預設為 `[]`），需要明確指定才會生效。

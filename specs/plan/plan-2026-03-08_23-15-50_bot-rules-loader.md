# Plan: 外部 Markdown 規則載入機制 (bot-rules-loader)

## Overview

目前 `session-manager.ts` 的 `systemPrompt` 使用 `claude_code` preset，SDK 支援透過 `append` 附加額外規則。此計劃將 `append` 的內容改為從外部 `.md` 檔案動態讀取，而非硬寫在 TypeScript 裡。

**目標**：讓 bot 行為規則可獨立維護，不需要修改程式碼即可調整 Claude 的行為規範。

**前置確認**（已驗證）：
- SDK `systemPrompt.append` 型別存在（`sdk.d.ts:1112-1116`）：`append?: string`
- PM2 cwd 固定為專案根目錄（`~/.pm2/dump.pm2` 確認）
- `tsx` dev 模式使用 `npm run dev` 從專案根目錄執行，`process.cwd()` 在兩種模式下均指向根目錄

## Implementation Steps

### 1. 新增 `src/utils/rules-loader.ts`

新建 utility，負責讀取外部 Markdown 規則檔：

```typescript
import fs from "node:fs";
import path from "node:path";

// process.cwd() 在兩種執行模式下均指向專案根目錄：
// - tsup production：pm2 cwd = 專案根目錄（已驗證）
// - tsx dev 模式：npm run dev 從專案根目錄執行
const ROOT_DIR = process.cwd();

export function loadBotRules(
  filename = "bot-rules.md",
  basePath?: string
): string | undefined {
  const filePath = path.join(basePath ?? ROOT_DIR, filename);
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined; // 檔案不存在時優雅降級
  }
}
```

**設計要點**：
- `process.cwd()` 在 production（PM2）和 dev（tsx）兩種模式下均指向專案根目錄
- 比 `import.meta.url` 方案更簡單，且同時支援兩種執行環境
- `basePath` 可選參數：生產環境省略（使用 ROOT_DIR），測試時傳入臨時目錄
- 找不到檔案時回傳 `undefined`（不拋錯，優雅降級）
- 回傳空字串時也視為無規則（`|| undefined`）

### 2. 修改 `src/claude/session-manager.ts`

在 `runSession()` 中讀取規則並傳入 `query()` options：

```typescript
import { loadBotRules } from "../utils/rules-loader.js";

// 在 runSession() 函數開頭（query() 呼叫之前）
const botRules = loadBotRules();

// query() options 中替換 systemPrompt
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  ...(botRules ? { append: botRules } : {}),
},
```

**修改順序**：先建 `rules-loader.ts`（步驟 1），再修改 `session-manager.ts`（本步驟）。

### 3. 新增 `bot-rules.md`（專案根目錄）

```markdown
## Discord Bot Context Rules

- 你正在透過 Discord Bot 提供服務，使用者透過手機或桌面的 Discord 介面互動
- 回覆請適當精簡，避免過長的輸出造成 Discord 訊息分割過多
- 若需要列出步驟，使用 numbered list 格式
```

### 4. Build & 驗證

```bash
npm run build && pm2 restart claudecode-discord
```

確認 TypeScript 編譯無錯誤後重啟 bot。

## Trade-offs & Decisions

| 決策 | 選擇 | 理由 |
|------|------|------|
| **讀取時機** | 每次 `runSession()` 呼叫時讀取 | 允許不重啟 bot 即可更新規則；檔案很小，IO 成本可忽略 |
| **檔案路徑** | 固定為 `bot-rules.md`（Phase 1） | 簡單優先；未來可透過 `.env` 的 `BOT_RULES_FILE` 設定 |
| **檔案不存在** | 優雅降級，不設定 `append` | 行為與現在相同，不破壞既有功能 |
| **sync vs async** | 同步讀檔 (`readFileSync`) | 與專案現有 i18n.ts 一致的模式；session 啟動時已非熱路徑 |
| **gitignore** | `bot-rules.md` 納入版控 | 屬於 bot 行為規範，應與程式碼一起版控 |
| **ROOT_DIR 策略** | `process.cwd()` | PM2 cwd 已確認為根目錄；tsx dev 從根目錄執行；比 `import.meta.url` 更簡單且同時支援兩種模式 |
| **basePath 參數** | 可選，預設使用 ROOT_DIR | 支援測試時注入臨時目錄，無需 mock fs 模組 |

**替代方案考量**：
- 將規則存入 DB → 過於複雜，不符合 MVP 原則
- 透過環境變數傳入 → 規則可能很長，不適合 env var
- 使用 `import.meta.url + ".."` → tsx dev 模式下指向 `src/`，需優雅降級，不如 `process.cwd()` 直接

## Tests

目前專案無對 `session-manager.ts` 的單元測試，新增的 `rules-loader.ts` 屬於純函數，CP 值高：

- **正常情況**：`basePath` 傳入含有 `bot-rules.md` 的臨時目錄，確認回傳內容字串
- **降級情況**：`basePath` 傳入不含 `bot-rules.md` 的目錄，確認回傳 `undefined`（不拋錯）
- **空檔案**：`bot-rules.md` 存在但內容為空，確認回傳 `undefined`
- **只有空白字元**：內容為 `"  \n\t  "`，確認 `.trim()` 後回傳 `undefined`

測試策略：使用 `basePath` 注入臨時目錄，**不需要 mock `fs` 模組**，測試更直覺可靠。
參照現有測試風格：`src/utils/config.test.ts`（vitest）。

測試檔位置：`src/utils/rules-loader.test.ts`

## Critical Files for Implementation

- `src/utils/rules-loader.ts` - ✅ 已實作（commit: 37b98b8）
- `src/claude/session-manager.ts` - ✅ 已修改（commit: 8318c8b）
- `bot-rules.md` - ✅ 已建立（commit: 4ac2609）
- `src/utils/rules-loader.test.ts` - ✅ 已建立（5 tests，全部通過）

## Completion Status

✅ **已完成**（2026-03-08）

- 98/98 全測試通過，TypeScript build 成功
- Gemini + Codex review：無 blocking issues
- Simplify：無需修改

# Restore Outbound Attachments (`[ATTACH:]`)

## Context

Cursor SDK migration（`d5438b5`）砍掉了「Cursor agent 主動把產生的圖／檔送回 Discord」的功能：
- 移除了 `extractAttachments` / `sendAttachments` helpers
- 移除了 `rules/BOT.md` 的注入機制（Cursor SDK 沒有對應 `systemPrompt.append` 的 API）

實機驗證後 user 想要回 agent 「貼圖給我」的能力。本 plan 用 spec 推薦的 **方案 B（fresh-session prepend）** 把三段重新接起來：instruction 注入 → marker 解析 → 上傳到 Discord。

## Approach

1. **Instruction 注入**：在 `Agent.create()` 路徑下（fresh session），把 bot 規則 prepend 到第一個 prompt。`Agent.resume()` 路徑相信 Cursor conversation history 會帶住 `[ATTACH:]` 慣例（R1 待驗證）。
2. **Marker 解析**：在 `run.wait().result` 拿到最終文字後跑 `extractAttachments()`，吐出乾淨文字 + 路徑列表。
3. **上傳**：在 result embed 之前 `await sendAttachments(channel, paths, project_path)`，沿用原本的 whitelist（`/tmp`、`/private/tmp`、`projectPath`，`fs.realpathSync` 防 symlink escape）+ dedupe + 10 個上限。

維持 MVP：**只解析 final result**（不串流邊解析邊上傳）；**不加 25MB / executable blocklist**（原本就沒有；Discord API 會自己拒絕 oversize，try/catch 已 cover）。

## Files to modify

| 檔案 | 變更 |
|---|---|
| `src/claude/output-formatter.ts` | 加回 `extractAttachments` + `sendAttachments` + `isAllowedPath` + 相關 imports（從 `d5438b5^` 撈回原版） |
| `src/claude/output-formatter.test.ts` | 加回對應測試（從 `d5438b5^` 撈回） |
| `src/claude/session-manager.ts` | (1) module-scope 讀入 rules 文字；(2) fresh-session 偵測 + prepend；(3) success branch 加 `extractAttachments` + `sendAttachments` 呼叫 |
| `rules/BOT.md` _(reuse as-is)_ | 既有檔案，已有 Discord context + `[ATTACH:]` 慣例 + Git rules — 跟 Claude 時代注入的是同一份，不動 |
| `CLAUDE.md` | (1) 從「MVP 階段砍掉的功能」拿掉 `[ATTACH:] outbound` + `rules/BOT.md 注入`；(2) 「附件上傳功能」段加 outbound 描述 |

## Detailed changes

### 1. `src/claude/output-formatter.ts` — restore helpers

從 `git show d5438b5^:src/claude/output-formatter.ts` 撈回（已驗證原始碼可用）：

```typescript
import { AttachmentBuilder } from "discord.js";  // 加到既有 import
import path from "node:path";
import fs from "node:fs";

const ALLOWED_PREFIXES = ["/tmp", "/private/tmp"];
const MAX_ATTACHMENTS = 10;

function isAllowedPath(filePath: string, projectPath?: string): boolean { /* realpathSync escape 防護 */ }

export function extractAttachments(text: string): {
  cleanText: string;
  attachmentPaths: string[];
} { /* 兩段 regex：bullet-line 整行移除 + 行內變空格 */ }

export async function sendAttachments(
  channel: Pick<TextChannel, "send">,
  attachmentPaths: string[],
  projectPath?: string,
): Promise<void> { /* dedupe → cap 10 → whitelist check → existsSync → channel.send({files}) */ }
```

完整 source 在 `d5438b5^` 可以直接 `git show` 抓取。

### 2. `src/claude/session-manager.ts` — wire up

**(a) Module-scope rules constant**（加在檔頭 imports 後）：

```typescript
import fs from "node:fs";
import path from "node:path";

const BOT_RULES = (() => {
  try {
    return fs.readFileSync(path.join(process.cwd(), "rules/BOT.md"), "utf8").trim();
  } catch {
    return "";  // 檔案不存在 → 不 prepend，optional feature
  }
})();
```

> `process.cwd()` 是 PM2 啟動目錄（claudecode-discord repo root），對齊既有 `rules/` 引用慣例。重用既有 `rules/BOT.md` — Claude 時代就是這個檔案被注入，內容（Discord context + ATTACH 慣例 + Git rules）沿用不動。

**(b) Fresh-session prepend**（line 175 附近，build `localOptions` 之後）：

```typescript
const isFreshSession = !resumeAgentId;
const augmentedPrompt = isFreshSession && BOT_RULES
  ? `${BOT_RULES}\n\n---\n\n${prompt}`
  : prompt;
```

把 line 206 的 `agent.send(prompt)` 改成 `agent.send(augmentedPrompt)`。

**(c) Parse + upload**（line 283 之前插入）：

```typescript
const resultText = final.result || L("Task completed", "작업 완료");
const { cleanText, attachmentPaths } = extractAttachments(resultText);

if (attachmentPaths.length > 0) {
  try {
    await sendAttachments(channel, attachmentPaths, project.project_path);
  } catch (e) {
    console.warn(`[attach] sendAttachments failed for ${channelId}:`, e instanceof Error ? e.message : e);
  }
}

const resultEmbed = createResultEmbed(
  cleanText,  // ← 改用 cleanText
  0,
  final.durationMs ?? Date.now() - startTime,
  config.SHOW_COST,
);
```

> 順序：attachments 先送、embed 後送。Discord 視覺上會是「先看到圖／檔，然後是描述文字 embed」。

### 3. Tests — restore

從 `git show d5438b5^:src/claude/output-formatter.test.ts` 撈回 `extractAttachments` 與 `sendAttachments` 的測試 cases，貼到現在的 `output-formatter.test.ts` 底部。預期保留現有 `splitMessage` / embed 測試不動。

### 4. `CLAUDE.md`

- 「MVP 階段砍掉的功能」: 拿掉 `❌ [ATTACH:] outbound 標記`
- 「附件上傳功能（inbound）」段改為「附件上傳功能（inbound + outbound）」，補一小段 outbound 流程描述（指向 `extractAttachments` / `sendAttachments` / `rules/CURSOR-BOT.md`）

## Verification

1. **單元測試** — `npm test`
   - 新增的 `extractAttachments` / `sendAttachments` 測試全綠
   - 既有測試（`session-manager.test.ts`、`output-formatter.test.ts`、`thread-reporter.test.ts`）不破
2. **型別檢查** — `npm run build` 通過
3. **End-to-end（fresh session）**
   - `pm2 restart claudecode-discord` 載入新版
   - Discord 內 `/new-session` → 訊息：「請產生一張 100×100 純色 PNG 存到 `/tmp/test-attach.png` 然後傳給我」
   - 預期：圖出現在 Discord 訊息流、result embed 不含 `[ATTACH: …]` 字樣
4. **End-to-end（resume session）** — 驗證 R1
   - 同一頻道隔幾分鐘再 ask「再產生一張紅色的傳我」
   - 預期：agent 仍照 `[ATTACH:]` 慣例輸出（不需要重新被告知）
   - 如果失敗 → R1 不成立，escalate 到「每次 send 都 prepend」（成本小）
5. **Safety smoke test**
   - 跑一輪 ask agent 寫個 `/etc/passwd-fake-path.txt` 之類的（白名單外路徑）
   - 確認 console.warn 印出 `Blocked attachment outside allowed paths` 且 Discord 顯示 `⚠️ Attachment blocked` 訊息，不真的上傳

## Risks（沿用 spec，加上目前判斷）

- **R1 (live)**：resume 路徑 agent 是否記得 `[ATTACH:]` 慣例。Mitigation：失敗就改成 every-send prepend（5 行改動）。
- **R2**：agent 把 instruction 反映成「我已收到指令」文字。Mitigation：rules 文字寫成像 system note 的口吻（「以下是 Discord bot 環境約定」），不用 second-person 命令句。如果還是漏，考慮 R3 escalation。
- **R3 fallback**：若 prepend 路線不穩，改寫 `AGENTS.md` 到 project 根（透過 `local.settingSources: ["all"]` 自動載入）— 需 user 同意污染專案目錄。
- **R4 deferred**：streaming-time 上傳屬 nice-to-have，本 plan 不做。

## Out of scope

- 25MB size check / executable extension blocklist（原本就沒有）
- Streaming 邊解析邊上傳（R4）
- AGENTS.md 注入路徑（R3 fallback）
- 路徑白名單擴充

---

## Completion

**Status**：✅ 完成、已 commit、production 驗證通過
**Commit**：`48c0571 feat(attachments): restore outbound [ATTACH:] upload markers`

### 規劃 vs 實作差異

- **Rules 檔案來源**：plan 原稿提了三個選項；user 指出 Cursor agent 跟 Claude agent 都跑在同一個 `project.project_path`，所以「BOT.md 內含 bot 自家 Git rules 會污染 user 專案」這擔心在 Claude 時代就成立但沒人抱怨。最終直接重用 `rules/BOT.md`（不另開 `CURSOR-BOT.md`、不 slim 既有內容）。
- **`BOT_RULES` 路徑解析**：plan 原稿假設用 `process.cwd()` 或單一深度 `../../rules/BOT.md`。實作初版用後者，**Codex review 抓到 tsup 把所有 src 打包成 flat `dist/index.js`，dist 模式下 `../../` 會跑到 repo 父目錄**。改成 candidates 陣列 `["../../rules/BOT.md", "../rules/BOT.md"]` 依序試，找不到時 `console.warn` 一次。
- **TOCTOU 強化**：plan 原稿沿用原版 `isAllowedPath` 回傳 boolean。**Codex review 指出 `AttachmentBuilder(filePath)` 用原始路徑、沒拿 realpath 結果**。重構成 `resolveIfAllowed` 回傳 `string | null`，downstream `fs.existsSync` + `AttachmentBuilder` 都吃 resolved path，關掉 symlink-name attack vector。
- **Regex 收緊**：原版 `[^\]]+` 不擋換行，可能吞多行。Codex 建議下改成 `[^\]\r\n]+`。

### Review 紀錄

- **Simplify pass**（3 個 parallel reviewer：reuse / quality / efficiency）— quality 點 4 個、efficiency 點 1 個；採用：hoist `allowed` 出迴圈、加 local `skipWith` helper、瘦註解、`try/catch` → `.catch()`。
- **review-loop (codex)**（session `019e356e-9be9-72f3-a11e-54adad1bd1a9`）：
  - R1：2 blocking（B1 dist 路徑、B2 TOCTOU）+ 3 suggestion，修了 B1、B2、S1（regex）、S3（README outdated）；skip S2（integration test out of MVP）
  - R2：0 blocking + 3 minor suggestion，加修 S6（BOT_RULES 找不到時 `console.warn`）；skip S4（path 內含 `]`）、S5（`realpathSync` fallback 簡化）
  - 終止條件：Situation A（無 blocking）

### Manual 驗證結果（4/4 ✓）

| # | 測試 | 結果 |
|---|---|---|
| 1 | Fresh session：產 PNG 到 `/tmp` → 傳回 | ✓ 圖正常出現、result embed 已 strip 掉 `[ATTACH:]` |
| 2 | Resume session：同頻道隔段時間再要圖 — **驗證 R1** | ✓ agent 仍照 `[ATTACH:]` 慣例輸出 — **R1 成立，不需 escalate 到 every-send prepend** |
| 3 | Safety：要 agent 寫 `/etc/seed-evil.txt` | ✓ log `[attach] Attachment blocked (outside allowed paths): /etc/seed-evil.txt`、Discord 顯示 ⚠️、檔案沒上傳 |
| 4 | Cap：要 12 張 PNG | ✓ log `[attach] Too many attachments (12), sending first 10`、只上傳前 10 張 |

### 後續可選改進（不阻擋）

- 整合測試覆蓋 `sendMessage()` success path（Codex S2）
- `[ATTACH:]` path 內 `]` escape 支援（Codex S4）— 目前 path 含 `]` 會被截斷
- `realpathSync` fallback 簡化（Codex S5）— 不是 bug，邊角清理
- Streaming-time 上傳（R4）— 長任務即時看到圖
- `project.project_path` 是 symlink 時 allowlist 漏判（Codex thought 但未升級）— pre-existing limitation

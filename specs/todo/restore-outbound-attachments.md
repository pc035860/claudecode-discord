# restore-outbound-attachments

**狀態**: 待規劃

恢復「Cursor agent 主動上傳檔案/圖片到 Discord」功能（outbound `[ATTACH:]` 慣例）。Migration 階段砍掉，現在 Cursor agent 沒有方法把產出的圖/檔案送回 Discord 訊息流。

## 背景

舊 Claude SDK 版本流程：
1. `rules/BOT.md` 注入到 `systemPrompt.append`，教 Claude「要附檔給 user 時寫 `[ATTACH: /絕對路徑]`」
2. session-manager 串流文字時 `extractAttachments()` 解析 marker → 收集路徑
3. 最後 `sendAttachments(channel, paths, projectPath)` 上傳到 Discord（含路徑白名單 / 去重 / 10 個上限）

Migration 砍掉的原因：Cursor SDK 沒 `systemPrompt`，agent 不會知道這個慣例，留著 helper 也沒人用。需要重新接 instruction 注入 + 解析 + 上傳三段。

## 方案

### Step 1: 注入 instruction（rules）

Cursor SDK 沒對應 `systemPrompt.append` 的 API。三條變通路：

| 方案 | 機制 | 優點 | 缺點 |
|---|---|---|---|
| **A.** 寫 `AGENTS.md` 到 project 根 | `local.settingSources: ["all"]` 自動載 | 每 session 自動看到，不重傳 token | 污染 user 專案目錄，跟 user 自己的 AGENTS.md 衝突 |
| **B.** `agent.send()` 前 prepend 到 first prompt | 動態，只在 fresh `Agent.create()` 路徑 prepend；resume 路徑依賴 Cursor conversation history | bot 自包，不碰專案；最少改動 | 進對話歷史可能被後續訊息「沖淡」，不像真正 system prompt sticky |
| **C.** `AgentOptions.agents` 定義 subagent + prompt | inline subagent system prompt | SDK 正式機制 | 主 agent 還是預設，需 delegate；太繞 |

**推薦 B**：MVP 取向，邏輯集中在 session-manager。

實作要點：
- 偵測 `resumeAgentId === null` 即為 fresh session
- 把 `rules/BOT.md` 內容（或新建一份 `rules/CURSOR-BOT.md`）讀入 module-scope const
- prompt 改成 `${BOT_RULES}\n\n---\n\n${userPrompt}`

### Step 2: 解析 `[ATTACH:]` marker

從 git history 撈回 `extractAttachments` helper（在 `d5438b5^:src/claude/output-formatter.ts` 約 line 65-83）。

兩個地方解析：
1. `run.wait().result` — 最終文字
2. （optional）stream 中的 `assistant` event text — 配合 Discord 即時上傳。MVP 可只在 final result 解析，邊串流邊上傳屬於 nice-to-have。

### Step 3: 上傳 + 安全限制

從 git history 撈回 `sendAttachments`（同檔案約 line 106-152）：
- 路徑白名單：`/tmp`, `/private/tmp`, project 目錄（透過 `fs.realpathSync` 解析 symlink 防 escape）
- 去重、上限 10 個
- 25MB / file 限制（Discord 免費 tier）
- 阻擋 executable 副檔名

整合到 session-manager `run.wait()` 之後：

```ts
const final = await run.wait();
const resultText = final.result || L(...);
const { cleanText, attachmentPaths } = extractAttachments(resultText);
await sendAttachments(channel, attachmentPaths, project.project_path);

const resultEmbed = createResultEmbed(cleanText, ...);
await channel.send({ embeds: [resultEmbed] });
```

## 影響檔案

- `src/claude/session-manager.ts` — fresh-session detection + prepend + result parsing + sendAttachments call
- `src/claude/output-formatter.ts` — 加回 `extractAttachments` / `sendAttachments` + helper consts
- `src/claude/output-formatter.test.ts` — 加回對應測試（git history 還在）
- `rules/BOT.md` 或新 `rules/CURSOR-BOT.md` — Discord 慣例 instruction 文字
- `CLAUDE.md` — 更新「附件上傳功能」段落

## 風險 / 待驗證

- **R1**：Cursor agent 是否會服從 conversation history 內的 instruction（方案 B 的核心假設）？要實機跑驗證，agent 真的會在後續 turn 用 `[ATTACH:]` 慣例寫嗎？
- **R2**：bot 把 instruction 塞進 user prompt，會不會被 agent 反映在「我已收到你的指令」這類自我引用文字裡？rules 寫法要小心讓 agent 當 system instruction 處理而非 user message。
- **R3**：`AGENTS.md` 方案的污染問題如果 user 接受，方案 A 比 B 穩定（Cursor 把 AGENTS.md 當 ambient context，不會被沖淡）。
- **R4**：streaming 中是否要邊解析邊上傳？MVP 只在 final result 解析最簡單，但代價是長任務的圖要等到最後才送出。

## 來源

Migration plan locked decision 4 + 5 砍掉了 outbound。User 在實機驗證後問「agent 可以貼圖給我嗎」，發現是個有實際需求的 feature。

相關 commit：
- `d5438b5` — migration 砍掉的範圍（output-formatter dead helpers）
- `61a4d33` — 原本加入 `[ATTACH:]` 功能的 commit

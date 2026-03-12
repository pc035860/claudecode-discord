# Bug: 主頻道漏顯示 assistant text

**狀態**: ✅ 已修復 (`acf2e97`)

## 問題描述

當 Claude 在最終回應前先輸出 assistant text，接著又執行工具（如 `agent-browser close`），該 assistant text 不會顯示在主頻道的訊息中。

## 重現步驟

1. Claude 回應中間輸出一段 assistant text（streaming）
2. Claude 接著呼叫一個工具（如 Bash `agent-browser close`）
3. 工具完成後 SDK 送出 result
4. 主頻道訊息只顯示最後的 result，中間的 assistant text 丟失

## 實際 log 範例

```
[10:54:07] [MAIN]     FILE [TOOL: Read] /tmp/feishu-page.png
[10:54:08] [MAIN]     DONE
[10:54:21] [MAIN]     ASST (sonnet 4-6)
    頁面能正常開啟，沒有登入牆~
    ...（長文）
[10:54:21] [MAIN]     SHELL $ agent-browser close
[10:54:21] [MAIN]     DONE
```

中間的 ASST 文字在 Discord 主頻道看不到。

## 根因分析

`session-manager.ts` 的 streaming text handler 使用 `responseBuffer` + 1.5 秒節流 edit：

- assistant text 進入 `responseBuffer`
- 節流 timer 還沒觸發時，下一個 tool call 開始
- `canUseTool` callback 不會觸發 buffer flush
- buffer 中的文字未及時 flush 到 Discord 訊息

## 修復方案

抽出共用 `flushBuffer(force?)` helper，在三個地方統一呼叫：

- `canUseTool` 入口：`await flushBuffer(true)` — 強制 flush，不等節流
- streaming text handler：`await flushBuffer()` — 受 1.5 秒節流控制
- result handler：`await flushBuffer(true)` — 強制 flush

關鍵防護：
- **attachment-only guard**：`extractAttachments` 後 `cleanText` 為空時直接 return，不覆蓋現有訊息
- **edit 失敗 fallback**：統一用 `channel.send()` 補送所有 chunks
- **multi-chunk fallback**：edit 失敗時逐一發送所有 chunks，不只最後一段

## 影響範圍

- `src/claude/session-manager.ts` L89-115（`flushBuffer` helper）
- `src/claude/session-manager.ts` L173（`canUseTool` 入口 flush）
- `src/claude/session-manager.ts` L375（streaming flush）
- `src/claude/session-manager.ts` L386（result flush）

# Bug: 主頻道漏顯示 assistant text

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
- 如果 tool 完成後直接進 result，result handler flush 的是最後的 buffer 狀態

可能的情況是 `responseBuffer` 有內容但被後續 streaming 覆蓋，或 edit 時機不對。

## 影響範圍

- `src/claude/session-manager.ts` L321-342（streaming text handler）
- `src/claude/session-manager.ts` L353-367（result flush）

## 可能方案

1. 在 `canUseTool` 入口強制 flush `responseBuffer` 到 `currentMessage`
2. 在 result handler 確保所有累積的 text 都被正確 edit 到主訊息

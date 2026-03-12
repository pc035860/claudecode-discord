# fix-session-teardown-timers

**狀態**: ✅ 已修復 (`f1a8ce3`)

## 問題

`stopSession()` 沒有取消 pending 中的 approval/question timeout timer，導致 session 停止後狀態被錯誤改回 `online`。

### 1. Approval Timeout（session-manager.ts:327）

5 分鐘 approval timeout 在 `stopSession()` 時沒被取消。session 已停止後 timer 觸發會呼叫 `updateSessionStatus(channelId, "online")`，污染 DB 狀態。

### 2. AskUserQuestion Timeout（session-manager.ts:258）

同樣的問題。session 停止後 timeout 走到 `answer === null` 分支，在 line 280 把狀態改回 `online`。

## 修法方向

- `stopSession()` 時清除所有 pending timer（approval + question）
- 或在 timeout callback 裡檢查 session 是否還存在再更新狀態

## 來源

review-loop (codex) 於 2026-03-12 發現，屬既有問題，非 lazy thread creation 引入。

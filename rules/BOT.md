## Discord Bot Context Rules

- 你正在透過 Discord Bot 提供服務，使用者透過手機或桌面的 Discord 介面互動
- 回覆請適當精簡，避免過長的輸出造成 Discord 訊息分割過多
- 若需要列出步驟，使用 numbered list 格式

## 附件上傳

當你需要讓使用者看到圖片或其他檔案時，在回應中加入以下標記：

```
[ATTACH: /絕對路徑/檔案名稱]
```

範例：
- 已將圖表儲存至 /tmp/chart.png [ATTACH: /tmp/chart.png]
- [ATTACH: /tmp/output.csv]

注意：
- 使用絕對路徑
- 確保檔案已寫入完成再標記
- 標記會被自動移除，使用者只會看到附件本身

## Git Commit Rules

- 此專案的 git commit 可以使用 `--no-gpg-sign` 跳過 GPG 簽名
- 原因：GPG sign 透過 1Password 同步，使用者不在電腦前時無法完成驗證
- 遇到 GPG sign 失敗時，直接加上 `--no-gpg-sign` 重試，無需等待使用者確認

# Encrypted Voice / Video Call — 視訊與擴充規劃

> 對應 README「Encrypted Voice / Video Call Roadmap」第八項。規劃視訊 UI、頻寬調度、螢幕分享、畫中畫以及未來多方通話擴充能力。

## 1. 視訊模式概觀

- 預設語音 → 可切換視訊；視訊僅在雙方 `capabilities.video = true` 時顯示。
- 撥號階段提供視訊預覽（局部鏡像畫面）。
- 通話中支援：
  - 雙擊切換遠端/本地焦點
  - 拖曳本地預覽
  - 暗光模式提示（顯示「建議開啟補光」）

## 2. 頻寬調度

- 三段式 profile：`video-high (720p)`, `video-med (540p)`, `video-low (360p)`。
- 以 `call-media-update` 發送目前 profile，對方接收後同步。
- 判斷指標：
  - `availableOutgoingBitrate`, `packetLoss`
  - CPU 使用率（避免低階裝置過熱）
- 降階策略：連續 5 秒封包遺失 > 8% → 降一階；恢復 10 秒後再升級。

## 3. 螢幕分享

- 以 `call-media-update` 宣告 `screenshare: true`。
- Web：使用 `getDisplayMedia()`，並限制 1080p/30fps。
- iOS：採用 `ReplayKit` Broadcast Upload Extension，並與 WebRTC pipeline 整合。
- UI：螢幕分享開始時顯示紅框提示，提供「停止分享」按鈕。

## 4. 画中画 / PiP

- Web：使用 `documentPictureInPicture` 或 `requestPictureInPicture`（若瀏覽器支援）。
- iOS：使用 `AVPictureInPictureController`，支援最小化視訊。
- PiP 內顯示最重要資訊（對方畫面 + 掛斷/靜音按鈕）。

## 5. 多方通話 / SFU 擴充

### 5.1 架構

- 預留 SFU (Selective Forwarding Unit) 模式：
  - 每個參與者與 SFU 建立一組 WebRTC 連線。
  - 仍沿用端對端加密：採用 SFrame，SFU 只轉送密文。

### 5.2 金鑰管理

- Call Master Key 再進一步為每位 Participant 產生 `participantKey`.
- 透過 `call-media-update` 發送 `participantKeyEnvelope`（Double Ratchet + access control）。
- 加入/離開時重新封裝，確保離線者無法解碼後續內容。

### 5.3 UI

- Grid 視圖（最多 4 人）與 Active Speaker 視圖。
- 顯示音量指示器，提供靜音控制。

## 6. 擴充點

- **錄影 / 記錄**：僅允許使用者自端錄製；若未來需要伺服器錄影，必須以 E2EE Proxy + 另開授權。
- **協作**：預留白板 / 共同瀏覽 API，透過 `call-data-channel` 傳輸同步資料。
- **Bots / IVR**：允許系統帳號加入通話（提醒或語音秘書）。

## 7. 待辦

1. 在前端 UI 實作視訊浮層、PiP 控制與螢幕分享按鈕。
2. 建立 `call/media-profile-manager` 模組處理頻寬調整。
3. iOS 端整合 ReplayKit 及 PiP 控制器。
4. 預留 SFU 相關設定（`calls/sfu-config.json`）與服務端入口。
5. 撰寫使用者指南（如何啟用視訊、螢幕分享注意事項）。

---

**狀態**：視訊與擴充規劃完成，待依此逐步實作。*** End Patch

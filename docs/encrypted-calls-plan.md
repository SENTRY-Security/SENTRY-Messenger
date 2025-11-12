# Encrypted Voice / Video Call — 需求與 UX 規劃（Web / iOS）

> 本文件對應 README「Encrypted Voice / Video Call Roadmap」中的第一項（需求盤點與 UX）。未來若需擴充，請延伸本文件並於 README 同步狀態。

## 1. 目標與範圍

- **目標**：提供端到端加密語音/視訊體驗，前期以 1 對 1 通話為主，需同時支援行動版 PWA 以及即將開發的 iOS 原生 App。
- **範圍**：
  - 呼叫建立/接聽/拒接/掛斷流程
  - 前景、背景與 App 被終止時的通知策略
  - UI 行為、控制元件配置、旋轉與安全鎖定狀態
  - 可延伸至視訊（畫面切換、螢幕分享）但本階段僅規劃，實作待後續項目

## 2. 主要使用情境

| 編號 | 情境 | 說明 |
| ---- | ---- | ---- |
| S1 | 前景語音通話 | 使用者已開啟 App，從聊天介面點擊通話鈕，對方在線或線上通知即可立即響鈴。 |
| S2 | 背景來電 | 使用者把 App 放到背景（PWA / iOS），需以推播/CallKit 喚醒並提供接聽/拒接。 |
| S3 | App 被系統終止 | iOS 可能因記憶體釋放關閉 App，本服務需透過推播 + 醒前信令重新載入基本資料。 |
| S4 | 網路轉換 | 通話中從 Wi-Fi 轉 4G / 5G 或訊號短暫中斷，需要自動重試與 UX 提示。 |
| S5 | 弱網語音優先 | 視訊模式下帶寬不足時，需自動降階為語音並提示使用者。 |
| S6 | CarPlay / 藍牙耳機 | 需轉交音訊輸出並維持加密。iOS App 需響應系統音訊路由變更。 |
| S7 | 使用者鎖定螢幕 | 通話持續，需提供鎖屏 overlay（iOS）或通知（PWA）顯示狀態與掛斷入口。 |

## 3. 使用者流程概覽

### 3.1 發起呼叫（Web / iOS 共用）

1. 使用者在聊天 UI 點擊語音/視訊鈕。
2. 前端檢查安全會話狀態（Double Ratchet ready）→ 產生 `callInit` 控制訊息。
3. 發送信令（`type: 'call-invite'`）到 WebSocket / Push。
4. 進入「撥號」畫面：顯示倒數/重試、掛斷按鈕。
5. 若對方接受 → 轉入媒體初始化；若拒接/忙線 → 顯示提示並返回聊天。

### 3.2 收到來電

1. Web 前景：浮層顯示來電卡片（同一頁 overlay），提供接聽/拒接/訊息回覆。
2. Web 背景：透過 Push API + Notification 顯示，點擊後帶回 App。
3. iOS：透過 APNs + PushKit → CallKit UI，接聽後啟動 App，帶入 `callToken`。
4. 接聽後載入會話資料並建立 WebRTC 連線（詳見後續實作項目）。

### 3.3 通話中 UI

共用控制列（mobile-first）：

| 控制 | 行為 |
| ---- | ---- |
| 靜音 | 切換麥克風狀態，顯示選擇結果。 |
| 擴音/喇叭 | 在 PWA 為 `AudioContext` Output 選擇；iOS 透過 AVAudioSession。 |
| 視訊切換 | 語音→視訊 / 視訊→語音，後者僅顯示音訊介面。 |
| 前/後鏡頭 | 視訊模式提供，並預留螢幕分享入口。 |
| 掛斷 | 結束會話、清除密鑰與 UI。 |

狀態顯示：

- 連線中（顯示 ICE / TURN 連線狀態）
- 加密中（顯示密鑰派生完成狀態）
- 網路不穩（自動重試 + 提示）

### 3.4 推播與通知

| 平台 | 策略 |
| ---- | ---- |
| PWA | Web Push + `notificationclick` → 開啟 App，並在 Service Worker 中帶入 call payload。 |
| iOS | APNs（前景 toast）、PushKit（CallKit 介面），確保 call invite 能落在 Native UI。 |

## 4. 設計與資產

- **Wireframe（描述）**：
  - `WF-01 撥號畫面`：顯示對方頭像、暱稱、狀態與掛斷鈕。
  - `WF-02 來電畫面`：全螢幕背景模糊 + 頭像，接聽/拒接/訊息回覆按鈕。
  - `WF-03 通話控制列`：下方操作列 + 中央狀態顯示（時長、加密狀態）。
  - `WF-04 視訊模式`：全螢幕遠端畫面 + 右下角本地預覽，控制列半透明浮起。
  - `WF-05 鎖屏通知`：簡化 UI（僅狀態與掛斷）並確保字體符合 iOS/Android guideline。
- **Design tokens**：沿用 `web/src/pages/app.html` 的色票，新增通話用漸層 (`#0f172a → #1d4ed8`) 與警示色 (`#ef4444`)。

## 5. iOS App 導入注意事項

- 信令與狀態機需輸出為可共享的 TypeScript + Swift 參考（例如以 JSON Schema 描述）。
- 推播 payload 需包含 `callToken` / `capability` 欄位，供 CallKit 直接顯示。
- 音訊路由與背景模式需註冊 `audio`, `voip`、並且在 Web 端也能對應（如耳機圖示）。
- UI 需支援動態字體（Dynamic Type）、語系變化。

## 6. 未來視訊擴充備註

- 預留畫中畫（Picture-in-Picture）對應（Web `documentPictureInPicture`、iOS `AVPictureInPictureController`）。
- 需要時可引入多方通話（SFU）架構，金鑰分發須擴充為 per-participant key wrap。

## 7. 待辦對應

- README Roadmap 第一項（需求盤點與 UX）**完成**：已列出情境、流程、通知策略與 iOS 整合注意事項。
- 後續項目（信令、加密媒體、NAT/TURN…）請依 README 逐項執行並在本文件延伸。

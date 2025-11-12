# Encrypted Voice / Video Call — 行動裝置 UI / 體驗設計

> 對應 README「Encrypted Voice / Video Call Roadmap」第五項。專注於 PWA / iOS App 共用的 UI 互動、樣式、背景行為與系統整合。

## 1. UI 構成

### 1.1 主要畫面

| 畫面 | 重點元素 | 備註 |
| ---- | -------- | ---- |
| 撥號（Caller） | 頭像、暱稱、狀態（Connecting / Ringing）、掛斷鈕 | 背景使用對方頭像模糊；顯示加密狀態圖示 |
| 來電（Callee） | 全螢幕背景、接聽/拒接/訊息回覆按鈕 | iOS 需呈現 CallKit UI，同步自訂色票 |
| 通話中（語音） | 時長、加密標籤、控制列（靜音/擴音/視訊/掛斷） | 控制列浮動，可上下滑動顯示詳細資訊 |
| 通話中（視訊） | 遠端畫面全螢幕、本地預覽縮圖、控制列 | 支援雙擊切換前/後鏡頭，PIP 預留 |
| 鎖屏 / 背景 | 簡化通知顯示狀態與掛斷按鈕 | PWA 使用通知＋後台 Service Worker |

### 1.2 控制列設計

- 5 顆主要按鈕：靜音、擴音/音訊輸出、視訊切換、螢幕分享（未開時灰色）、掛斷（紅）。
- 圓形按鈕 56px，間距 12px，背景 `rgba(15,23,42,0.65)`。
- 動畫：按下時縮放 0.95，長按顯示子選單（例如音訊裝置選擇）。

## 2. 行動裝置體驗

### 2.1 Web PWA

- `wakeLock` API：通話中保持螢幕常亮，除非使用者手動鎖定。
- Background Sync：若網路切斷，於重連後自動送出 `call-media-update`。
- Manifest 加入 `"display_override": ["standalone"]`，避免瀏覽器 UI 影響。

### 2.2 iOS App

- CallKit 整合：
  - 顯示自訂標誌（需 100×100 PNG）。
  - 支援 `CXProvider` 動作（接聽、拒接、靜音）。
  - 通話中顯示加密狀態（自訂 label）。
- Audio Focus：
  - 使用 `AVAudioSessionCategoryPlayAndRecord`，支援藍牙/CarPlay。
  - 監聽 `AVAudioSession.routeChangeNotification` 切換 UI 圖示。
- 背景模式：
  - 啟用 `audio`, `voip` capability。
  - 當 App 被系統終止時，PushKit 喚醒後需立即呼叫 `/api/v1/calls/ack` 續傳狀態。

## 3. Design Tokens

| Token | 值 | 描述 |
| ----- | --- | ---- |
| `call.bg` | `linear-gradient(160deg,#0f172a,#1d4ed8)` | 通話背景 |
| `call.button.voice` | `#0ea5e9` | 通話按鈕（語音） |
| `call.button.video` | `#a855f7` | 通話按鈕（視訊） |
| `call.button.hangup` | `#ef4444` | 掛斷 |
| `call.text.primary` | `#f8fafc` | 主要文字 |
| `call.text.muted` | `rgba(248,250,252,0.65)` | 次要文字 |

Design tokens 準備 JSON + iOS Color Set：

```jsonc
{
  "call": {
    "bg": ["#0f172a", "#1d4ed8"],
    "button": { "voice": "#0ea5e9", "video": "#a855f7", "hangup": "#ef4444" },
    "text": { "primary": "#f8fafc", "muted": "rgba(248,250,252,0.65)" }
  }
}
```

## 4. 動態狀態與提示

- 顯示加密狀態：`Secured` / `Rekeying…` / `Unsecured (retrying)`。
- 網路狀態提示：
  - `網路不穩，嘗試切換 Wi-Fi`
  - `已切換純語音以維持通話`
- 錯誤提示：`無法取得麥克風權限`、`耳機未連線` 等。

## 5. 互動流程

1. **撥號**：Call button → 進入撥號畫面 → 3 秒內顯示「正在建立加密通道…」進度。
2. **來電**：通知/CallKit → 使用者接/拒 → 若接聽，顯示「載入密鑰」動畫 → 轉入通話畫面。
3. **切換視訊**：點擊視訊鈕 → 彈窗確認（提醒對方會看到畫面）→ 發送 `call-media-update`。
4. **背景/鎖屏**：顯示原生通知 + 小型掛斷鈕；回到 App 時恢復完整 UI。

## 6. 系統權限

- 首次通話需提示麥克風／相機權限，並導引使用者前往設定調整。
- 若權限被撤回，UI 顯示明顯警告並提供快捷連結（PWA：`navigator.permissions`；iOS：開啟設定）。

## 7. 無障礙 / 多語系

- 按鈕提供 `aria-label` / VoiceOver label。
- 支援動態字體（iOS）與字體放大（Web）。
- 文案多語系放在 `web/src/locales/calls.json`（待建立），iOS 使用 Localizable.strings。

## 8. 待辦總結

1. 在 web app 加入通話專用 UI component（`call-overlay`）。
2. 實作行動控制列與狀態提示邏輯。
3. 產出 design token JSON + iOS Color Asset。
4. 設計 CallKit 介面資產與流程文件。
5. 建立多語系／無障礙文案。

---

**狀態**：設計完成，可依此實作 PWA 與 iOS 通話 UI。README Roadmap 已更新為完成。*** End Patch

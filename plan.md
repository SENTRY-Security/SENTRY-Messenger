# PWA Web Push 通知系統實作計畫

## 目標
讓使用者在瀏覽器關閉/背景時收到「有新訊息」通知（不含訊息內容，符合 E2EE 原則）。設定頁啟用時先跳說明確認頁。

---

## 架構概覽

```
[訊息進入 DO] → sent === 0（無 WS 連線）
      ↓
[DO 查 KV push subscription]
      ↓
[用 Web Push Protocol 發送推播]
      ↓
[瀏覽器/OS 喚醒 Service Worker]
      ↓
[SW 顯示系統通知：「你有新訊息」]
```

---

## 實作步驟

### 1. 前端：Service Worker (`web/src/sw.js`)

新建 `sw.js`，放在 `web/src/` 根目錄（確保 scope 為 `/`）：
- 監聽 `push` event → 顯示 `self.registration.showNotification()`
- 通知標題/內容用通用文字（E2EE 不傳明文）
- 監聽 `notificationclick` → `clients.openWindow('/pages/app.html')`
- 不做任何離線快取（這不是完整 PWA，只用推播功能）

### 2. 前端：manifest.json (`web/src/manifest.json`)

最小化的 Web App Manifest，僅提供 PWA 安裝所需資訊：
- `name`, `short_name`, `start_url`, `display: standalone`
- `icons` 引用現有 logo
- `background_color`, `theme_color`

在 `app.html` 的 `<head>` 中加入 `<link rel="manifest" href="/manifest.json">`

### 3. 前端：推播管理模組 (`web/src/app/features/push-subscription.js`)

新模組負責：
- `subscribePush()`: 請求通知權限 → `registration.pushManager.subscribe()` → 送 subscription 到後端
- `unsubscribePush()`: 取消訂閱 → 通知後端刪除
- `getPushStatus()`: 檢查當前訂閱狀態
- VAPID public key 從環境變數或 hardcode 帶入

### 4. 前端：設定頁 UI（修改 `settings-modal.js`）

在「語言」設定項下方新增「推播通知」開關：
- Toggle switch，同現有 autoLogoutOnBackground 樣式
- **啟用時**：先跳說明確認 Modal（用現有 `showAlertModal` 或 `openModal`）
  - 說明內容：
    - iOS 使用者需先「加入主畫面」
    - 將請求瀏覽器通知權限
    - 只會通知「有新訊息」，不會顯示內容
  - 確認按鈕 → 呼叫 `subscribePush()`
  - 取消 → toggle 恢復關閉
- **關閉時**：呼叫 `unsubscribePush()`

### 5. 前端：Settings 資料模型（修改 `settings.js`）

- `DEFAULT_SETTINGS` 新增 `pushNotifications: false`
- `normalizeSettings()` 新增 `pushNotifications` boolean 正規化
- `persistPatch` 的 `trackedKeys` 新增 `'pushNotifications'`

### 6. 前端：SW 註冊（修改 `app-mobile.js`）

在 app 初始化時（bootLoad 之後）：
```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
```
只註冊，不自動訂閱推播。訂閱由設定頁觸發。

### 7. 前端：Build 設定（修改 `build.mjs`）

- `staticFiles` 陣列新增 `'sw.js'`, `'manifest.json'`
- SW 必須在根路徑，build 時從 `src/sw.js` 複製到 `dist/sw.js`

### 8. 前端：CSP Headers（修改 `_headers`）

- `worker-src` 已含 `'self'`，SW 可正常載入
- 無需修改（確認即可）

### 9. 前端：i18n（修改所有 locale JSON）

新增 `settings.pushNotifications` 相關翻譯：
- `settings.pushNotifications`: "Push notifications" / "推播通知"
- `settings.pushNotificationsDesc`: "Receive notification when new messages arrive" / "收到新訊息時顯示系統通知"
- `settings.pushExplainTitle`: "Enable push notifications" / "啟用推播通知"
- `settings.pushExplainBody`: 說明文字（iOS 需加主畫面、只通知有新訊息等）
- `settings.pushExplainIOS`: iOS 專屬說明
- `settings.pushEnabled`: "Push notifications enabled" / "推播通知已啟用"
- `settings.pushDisabled`: "Push notifications disabled" / "推播通知已關閉"
- `settings.pushPermissionDenied`: "Notification permission denied" / "通知權限被拒絕"

### 10. 後端：Push Subscription API（修改 `worker.js`）

新增兩個端點：

**`POST /d1/push/subscribe`**
- 接收：`{ accountDigest, deviceId, subscription }` (subscription = PushSubscription JSON)
- 存入 D1 表 `push_subscriptions`
- 需認證（同其他 /d1/ 端點）

**`POST /d1/push/unsubscribe`**
- 接收：`{ accountDigest, deviceId, endpoint }`
- 從 D1 表刪除對應記錄

### 11. 後端：D1 Schema

新增 `push_subscriptions` 表：
```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(account_digest, endpoint)
);
CREATE INDEX idx_push_sub_account ON push_subscriptions(account_digest);
```

### 12. 後端：VAPID Key 配置（修改 `wrangler.toml`）

新增環境變數：
- `VAPID_PUBLIC_KEY` — 前端用，可公開
- `VAPID_PRIVATE_KEY` — Worker secret，用於簽署推播
- `VAPID_SUBJECT` — `mailto:` 或 URL

### 13. 後端：Web Push 發送（修改 `account-ws.js`）

在 `_handleNotify()` 中，當 `sent === 0`（無活躍 WS 連線）時：
- 查詢 D1 的 `push_subscriptions`（by accountDigest）
- 用 Web Push Protocol（RFC 8291）發送推播
- Payload：`{ type: 'new-message', ts: Date.now() }`（通用，不含明文）
- 實作 Web Push 加密（ECDH + HKDF + AES-128-GCM）

由於 Cloudflare Workers 沒有 `web-push` npm 包的直接支援（依賴 Node crypto），需用 Web Crypto API 實作：
- 新建 `data-worker/src/web-push.js` 工具模組
- VAPID JWT 簽名（ES256）
- Push payload 加密（RFC 8291: ECDH + HKDF + AES-128-GCM）
- 向 push service endpoint 發送 HTTP POST

### 14. 前端：SW 快取策略 Headers

新增 `_headers` 規則：
```
/sw.js
  Cache-Control: no-cache, must-revalidate, max-age=0
  Service-Worker-Allowed: /
```
確保 SW 更新時立即生效。

---

## 檔案變更清單

| 操作 | 檔案 |
|------|------|
| 新建 | `web/src/sw.js` |
| 新建 | `web/src/manifest.json` |
| 新建 | `web/src/app/features/push-subscription.js` |
| 新建 | `data-worker/src/web-push.js` |
| 修改 | `web/src/app/ui/mobile/modals/settings-modal.js` |
| 修改 | `web/src/app/features/settings.js` |
| 修改 | `web/src/app/ui/app-mobile.js` |
| 修改 | `web/src/pages/app.html` |
| 修改 | `web/build.mjs` |
| 修改 | `web/src/_headers` |
| 修改 | `web/src/locales/en.json` |
| 修改 | `web/src/locales/zh-Hant.json` |
| 修改 | `web/src/locales/zh-Hans.json` (+ ja, ko, th, vi) |
| 修改 | `data-worker/src/worker.js` |
| 修改 | `data-worker/src/account-ws.js` |
| 修改 | `data-worker/wrangler.toml` |

---

## 使用者流程

1. 使用者進入「設定」→ 看到「推播通知」開關
2. 點擊啟用 → 彈出說明確認頁
3. 確認後 → 瀏覽器彈出通知權限請求
4. 授權後 → 訂閱 Push → 儲存到後端
5. 之後：
   - 有 WS 連線時 → 照舊走 WS 即時通知
   - 無 WS 連線時 → DO 觸發 Web Push → 系統通知「你有新訊息」
6. 點擊通知 → 開啟 app.html

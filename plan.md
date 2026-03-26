# PWA Web Push 通知系統實作計畫 ✔ COMPLETED (2026-03-24)

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

### 15. 前端：PWA 精簡介面（`web/src/pages/pwa-push.html`）

**用途**：使用者從主畫面開啟 PWA 時（無法登入，因為需要 NTAG424 晶片），顯示精簡的推播管理介面。

**偵測方式**：在 `app.html` 的早期 inline script 中判斷：
```js
const isPWA = window.matchMedia('(display-mode: standalone)').matches
           || window.navigator.standalone === true;
if (isPWA) {
  location.replace('/pages/pwa-push.html');
}
```

**頁面內容**（獨立 HTML，不經過 app-mobile.js）：
- 品牌 Logo + 標題
- i18n 支援（同 login.html 用 inline `__t()` 載入）
- 推播狀態顯示（已啟用 / 已關閉 / 權限被拒）
- 「關閉推播通知」按鈕 → 呼叫 `pushManager.getSubscription().then(s => s.unsubscribe())` + 通知後端刪除
- 推播限制完整說明區塊（見下方）
- 底部連結：「在瀏覽器中開啟以使用完整功能」

**推播限制說明區塊**（詳細、分平台）：

> **推播通知說明**
>
> **基本資訊**
> - 推播通知僅會顯示「你有新訊息」，**不會包含任何訊息內容**
> - 所有訊息內容皆受端對端加密保護，伺服器無法讀取
> - 推播僅在您**未開啟應用**時觸發；開啟中則走即時連線
>
> **iOS (iPhone / iPad)**
> - 必須先將此應用「**加入主畫面**」才能接收推播
>   - Safari → 分享按鈕 (□↑) → 加入主畫面
> - 需 **iOS 16.4** 或以上版本
> - iOS 會在背景自動管理通知，不需要此應用持續運行
> - 部分 iOS 版本可能偶發延遲（通常數秒內送達）
>
> **Android (Chrome)**
> - 支援最完整，關閉瀏覽器後仍可收到通知
> - 需在瀏覽器彈出的權限視窗中按「允許」
> - 若曾封鎖通知權限，需到瀏覽器設定 > 網站設定 > 通知 中重新允許
>
> **桌面瀏覽器 (Chrome / Edge / Firefox)**
> - 瀏覽器關閉後仍可收到推播（瀏覽器背景程序需運行）
> - macOS 使用者需確認系統「通知」設定中已允許瀏覽器通知
>
> **不支援推播的環境**
> - Firefox iOS 版（iOS 上僅 Safari/Chrome 支援）
> - 無痕模式 / 隱私瀏覽模式
> - 部分企業受管理的瀏覽器
>
> **可靠性說明**
> - Web Push 由各平台的推播伺服器（Apple APNs / Google FCM / Mozilla）中繼
> - 送達率約 90%+，極少數情況可能延遲數分鐘
> - 本通知為輔助功能，重要訊息請定期開啟應用查看

**不需要認證**：`pushManager.getSubscription()` 是瀏覽器 API，PWA 頁面可直接操作本機的推播訂閱，不需要 NTAG 登入。但若需同步通知後端刪除 subscription，需呼叫 `/d1/push/unsubscribe`（端點允許 endpoint 作為唯一識別，無需帳號認證）。

### 16. 前端：設定頁裝置推播管理（修改 `settings-modal.js`）

在推播通知開關下方，新增**已註冊裝置列表**：

**UI 設計**：
```
推播通知        [開關]
收到新訊息時顯示系統通知

  已註冊的推播裝置：
  ┌─────────────────────────────┐
  │ 🔔 此裝置         [撤銷]   │
  │ 🔔 iPhone Safari   [撤銷]   │
  │ 🔔 Chrome Desktop  [撤銷]   │
  └─────────────────────────────┘
```

**資料來源**：
- 新增 API 端點 `POST /d1/push/list`
  - 接收：`{ accountDigest }`
  - 回傳：`[{ device_id, endpoint, created_at, user_agent }]`
  - 需認證（同其他 /d1/ 端點）

**裝置識別**：
- D1 表 `push_subscriptions` 新增 `user_agent TEXT` 欄位
- 訂閱時一併儲存 `navigator.userAgent`，用於顯示裝置名稱
- 前端解析 UA 為人類可讀格式（如「iPhone Safari」「Chrome Windows」）

**撤銷流程（雙方同步）**：
1. 使用者在設定頁點擊「撤銷」某裝置
2. 前端呼叫 `POST /d1/push/unsubscribe` → 後端刪除該 subscription 記錄
3. 後端回傳 `{ ok: true, endpoint }` → 前端刷新列表
4. **若撤銷的是「此裝置」**：同時呼叫本機 `pushManager.getSubscription().then(s => s?.unsubscribe())`
5. **若撤銷的是「其他裝置」**：
   - 後端已刪除 subscription，該裝置不會再收到推播
   - 下次該裝置的 PWA 頁面開啟時，`getSubscription()` 仍會回傳已失效的 subscription
   - DO 發送推播時若 push service 回傳 410 Gone → 自動清理殘留記錄
   - 該裝置若從 PWA 頁面檢查狀態，發現後端無記錄 → 顯示「已停用」

**確認對話框**：
撤銷前顯示確認：「確定要撤銷此裝置的推播通知？該裝置將不再收到新訊息通知。」

### 17. 後端：Push 裝置列表 API（修改 `worker.js`）

**`POST /d1/push/list`**
- 接收：`{ accountDigest }`
- 回傳：`{ items: [{ device_id, endpoint, user_agent, created_at }] }`
- 需認證

### 18. 後端：推播失敗自動清理（修改 `web-push.js`）

Web Push 發送後檢查回應：
- **410 Gone** 或 **404 Not Found** → subscription 已失效，自動從 D1 刪除
- **429 Too Many Requests** → 尊重 Retry-After，暫停推播
- 其他錯誤 → log 但不刪除（可能是暫時性錯誤）

### 19. 後端：D1 Schema 更新

`push_subscriptions` 表最終版：
```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  user_agent TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(account_digest, endpoint)
);
CREATE INDEX idx_push_sub_account ON push_subscriptions(account_digest);
```

### 20. 前端：manifest.json 的 start_url

```json
{ "start_url": "/pages/app.html?source=pwa" }
```
搭配 `display-mode: standalone` 偵測，雙重確認 PWA 來源。

---

## 檔案變更清單

| 操作 | 檔案 |
|------|------|
| 新建 | `web/src/sw.js` |
| 新建 | `web/src/manifest.json` |
| 新建 | `web/src/pages/pwa-push.html` |
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

### A. 首次啟用（瀏覽器登入後）

1. 使用者進入「設定」→ 看到「推播通知」開關
2. 點擊啟用 → 彈出說明確認頁（含完整推播限制說明）
3. 確認後 → 瀏覽器彈出通知權限請求
4. 授權後 → 訂閱 Push → subscription 儲存到後端
5. 之後：
   - 有 WS 連線時 → 照舊走 WS 即時通知
   - 無 WS 連線時 → DO 觸發 Web Push → 系統通知「你有新訊息」
6. 點擊通知 → 開啟 app.html

### B. PWA 主畫面開啟

1. 使用者從主畫面開啟 PWA
2. 偵測 `display-mode: standalone` → 導向 `pwa-push.html`
3. 顯示推播狀態 + 推播限制完整說明
4. 可直接關閉推播（本機取消訂閱 + 通知後端）
5. 無法登入或使用其他功能

### C. 從設定頁管理其他裝置

1. 使用者在設定頁看到「已註冊的推播裝置」列表
2. 點擊某裝置的「撤銷」→ 確認對話框
3. 確認後 → 後端刪除該 subscription
4. 該裝置不再收到推播（DO 側生效）
5. 若撤銷的是本機裝置 → 同時取消本機 SW 訂閱

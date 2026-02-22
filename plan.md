# 配對碼加好友功能實作計劃

## 概述
在現有 QR Code 加好友流程旁，新增「6 碼配對碼」方式。點擊「加好友」按鈕後先跳出選單（QR / 配對碼）。配對碼 Modal 預設顯示自己的 6 碼（唯讀），可切換為輸入對方碼的模式。

## 修改檔案清單

### 1. 資料庫遷移
**新增**: `data-worker/migrations/0007_add_pairing_code.sql`
```sql
ALTER TABLE invite_dropbox ADD COLUMN pairing_code TEXT;
ALTER TABLE invite_dropbox ADD COLUMN prekey_bundle_json TEXT;
CREATE UNIQUE INDEX idx_invite_dropbox_pairing_code
  ON invite_dropbox(pairing_code)
  WHERE pairing_code IS NOT NULL AND status = 'CREATED';
```

### 2. Data Worker — `data-worker/src/worker.js`

#### 2a. 修改 `/d1/invites/create` (~line 1486)
- 產生隨機 6 碼數字（`000000`-`999999`）
- 碰撞檢查：查詢未過期 + status=CREATED 的碼，若碰撞就重新產生（最多 10 次）
- INSERT 時加入 `pairing_code` + `prekey_bundle_json` 欄位
- **配對碼模式時** `expires_at` = `now + 180`（3 分鐘），QR 模式保持 300 秒
- Response 加入 `pairing_code`

#### 2b. 新增 `/d1/invites/lookup-code`
- 接收 `pairingCode` (6 碼) + `accountToken` + `accountDigest`
- Rate limit（記憶體 Map）：
  - Key: `account_digest`
  - 每次查詢失敗（碼不存在/已過期）+1 attempt
  - 達到 3 次 → 鎖定 30 秒
  - 成功查詢 → 重置計數
- 查詢 `invite_dropbox WHERE pairing_code=? AND status='CREATED' AND expires_at > now`
- 回傳完整 invite 資料（invite_id, owner_account_digest, owner_device_id, owner_public_key_b64, expires_at, prekey_bundle）

### 3. Express Controller — `src/controllers/invites.controller.js`

#### 3a. 修改 `createInviteDropbox()`
- Response 加入 `pairing_code` 欄位

#### 3b. 新增 `lookupPairingCode()`
- Zod schema: `{ pairing_code: z.string().regex(/^\d{6}$/), account_token, account_digest? }`
- 驗證帳號 → 轉發至 `/d1/invites/lookup-code`
- 回傳完整 invite 資料

### 4. 路由 — `src/routes/v1/invites.routes.js`
- 新增 `r.post('/invites/lookup-code', lookupPairingCode)`

### 5. Client API — `web/src/app/api/invites.js`
- 新增 `invitesLookupCode({ pairingCode })` 函式

### 6. HTML — `web/src/pages/app.html`

#### 6a. 加好友選單（在 btnShareModal 附近）
```html
<div id="addFriendMenu" class="add-friend-menu" style="display:none">
  <button id="btnAddFriendQr">QRCode 加好友</button>
  <button id="btnAddFriendCode">使用配對碼</button>
</div>
```

#### 6b. 配對碼 Modal
```html
<div id="pairingCodeModal" class="modal pairing-code-modal" style="display:none">
  <div class="modal-backdrop" data-pairing-close></div>
  <div class="modal-panel pairing-code-panel">
    <header class="pairing-code-head">
      <button class="share-close" data-pairing-close-btn>×</button>
      <span class="pairing-code-title">配對碼</span>
    </header>
    <div class="pairing-code-body">
      <div class="pairing-code-countdown">
        <span id="pairingCountdown"></span>
        <button id="pairingRefreshBtn" type="button"><i class='bx bx-refresh'></i></button>
      </div>
      <div id="pairingDigits" class="pairing-code-digits">
        <input type="tel" maxlength="1" readonly />  (×6)
      </div>
      <div class="pairing-code-actions">
        <button id="btnPairingToggle" type="button">輸入對方配對碼</button>
        <button id="btnPairingConfirm" type="button" style="display:none">確認</button>
      </div>
    </div>
  </div>
</div>
```

### 7. CSS — `web/src/assets/app-share.css`
- `.add-friend-menu` 彈出選單樣式
- `.pairing-code-modal` / `.pairing-code-panel` Modal 樣式
- `.pairing-code-digits` 6 格 PIN 輸入框
- 倒數計時（共用現有 countdown 風格）

### 8. Share Controller — `web/src/app/ui/mobile/controllers/share-controller.js`

#### 8a. 修改 `btnShareModal` click (line 329)
- 改為顯示 `addFriendMenu` 選單

#### 8b. 新增配對碼邏輯
- `openPairingCodeModal()` — 開 Modal + 建立 invite + 顯示 6 碼
- `closePairingCodeModal()` — 關閉 Modal
- `togglePairingMode()` — 切換 readonly/input 模式
- `onPairingConfirm()` — 呼叫 `invitesLookupCode` → 走 `handleInviteScan` 同路徑
- `startPairingCountdown()` — 3 分鐘倒數，到期自動刷新
- PIN 輸入框自動跳格邏輯

#### 8c. return 新增 public API
- `openPairingCodeModal`, `closePairingCodeModal`

### 9. app-mobile.js — `web/src/app/ui/app-mobile.js`
- 新增 DOM element references（addFriendMenu, pairingCodeModal 等）
- 傳遞新 DOM elements 到 share-controller

## 流程

```
User clicks "加好友"
    ↓
┌─────────────┐
│  選單彈出    │
│  1. QR Code  │ → 現有 shareModal 流程
│  2. 配對碼   │ → 配對碼 Modal
└─────────────┘
    ↓ (選配對碼)
POST /api/v1/invites/create → 回傳 { invite_id, pairing_code, ... }
    ↓
┌───────────────────────────┐
│  配對碼 Modal              │
│  [4] [8] [2] [9] [1] [7]  │ ← readonly，我的碼
│  [輸入對方配對碼]           │
└───────────────────────────┘
    ↓ (點擊 "輸入對方配對碼")
┌───────────────────────────┐
│  配對碼 Modal              │
│  [ ] [ ] [ ] [ ] [ ] [ ]  │ ← 可輸入
│  [顯示我的配對碼] [確認]    │
└───────────────────────────┘
    ↓ (輸入 6 碼 + 確認)
POST /api/v1/invites/lookup-code { pairing_code }
    ↓
回傳完整 invite 資料 → 走 handleInviteScan 同路徑（deliver + x3dh）
```

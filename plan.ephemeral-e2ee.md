# Ephemeral E2EE 修復計畫

## 問題摘要

Ephemeral 對話目前為**完全明文通道**，與正常對話的 E2EE 標準不一致：
- 訊息以 plaintext JSON 透過 WebSocket 傳送/中繼
- `prekey_bundle_json` 欄位存在但從未使用（永遠傳 `{}`）
- 通話信令（SDP/ICE）以明文傳送
- 伺服器可讀取所有 ephemeral 訊息內容

## 修復目標

讓 ephemeral 對話的**訊息**走 E2EE，達到與正常對話相同的安全等級：
- X3DH 金鑰交換建立共享密鑰
- Double Ratchet 加密所有文字訊息
- 伺服器僅中繼密文，無法讀取明文

> **範圍限定**：通話信令（SDP/ICE）加密不在本次範圍。
> 正常對話的通話信令目前也是明文走 WS（`calls/signaling.js`），
> 後續統一升級正常對話與 ephemeral 的通話信令加密。

## 複用策略分析

### 可直接複用的模組（`shared/crypto/` 層）

正常對話的加密分兩層：
1. **底層 crypto 原語**（`shared/crypto/`）— 純函式，無副作用，可直接複用
2. **上層 session 管理**（`app/features/dr-session.js`）— 深度耦合 store、IndexedDB、contacts、outbox、vault

Ephemeral **直接複用底層**，不經過上層：

| 模組 | 路徑 | 複用方式 |
|------|------|---------|
| `generateInitialBundle` | `shared/crypto/prekeys.js` | **直接 import** — 產生臨時 X3DH 金鑰對 |
| `x3dhInitiate` | `shared/crypto/dr.js` | **直接 import** — Guest 側建立 DR state |
| `x3dhRespond` | `shared/crypto/dr.js` | **直接 import** — Owner 側建立 DR state |
| `drEncryptText` | `shared/crypto/dr.js` | **直接 import** — 加密訊息 |
| `drDecryptText` | `shared/crypto/dr.js` | **直接 import** — 解密訊息 |
| `loadNacl` | `shared/crypto/nacl.js` | **直接 import** — 確保 crypto 初始化 |

### 不複用的模組（上層耦合太深）

| 模組 | 原因 |
|------|------|
| `dr-session.js` `sendDrPlaintext` | 依賴 `getAccountDigest`、`conversationContextForPeer`、`drState()`、`persistDrSnapshot`、outbox queue、atomic send、vault — 全部是註冊用戶基礎設施 |
| `messages-flow-legacy.js` | Facade 依賴 legacy pipeline、timeline store、message DB |
| `api/messages.js` `createSecureMessage` | 將密文存入 `messages_secure`（ephemeral 不持久化） |
| `MessageKeyVault` | 依賴 MK + IndexedDB（ephemeral 不需要 vault） |

### 複用等級結論

> **Ephemeral 複用與正常對話完全相同的加密演算法和協定實作**（X3DH + Double Ratchet + AES-256-GCM），
> 差異僅在 session 管理層（記憶體 vs IndexedDB）和傳輸層（WS 直送 vs outbox → API → 持久化）。
>
> 加密品質 100% 等同正常對話。

## 設計原則

1. **複用 `shared/crypto/` 全部加密原語**：與正常對話使用完全相同的 X3DH + DR 程式碼
2. **不修改 DB schema**（AGENTS.md 禁止）
3. **不修改加密演算法**（AGENTS.md 禁止）
4. **DR state 僅存於記憶體**：Owner 側在 controller Map、Guest 側在模組變數
5. **嚴格遵守 SECURITY POLICY**：無 fallback、無 retry、失敗即 fail

## 修改範圍

### Step 1: Owner 端 — 建立連結時附帶 Prekey Bundle

**檔案**: `web/src/app/ui/mobile/controllers/ephemeral-controller.js`

修改 `_showCreateModal()`:
```javascript
import { generateInitialBundle } from '../../../../shared/crypto/prekeys.js';

// 在 _showCreateModal() 中:
const { devicePriv, bundlePub } = await generateInitialBundle(1, 1);  // 只需 1 個 OPK
const data = await ephemeralCreateLink({ prekeyBundle: bundlePub });
// 暫存私鑰，等待 guest key-exchange
this._pendingInviteKeys.set(data.token, devicePriv);
```

新增成員變數：
- `this._pendingInviteKeys = new Map()` — token → devicePriv
- `this._drStates = new Map()` — session_id → DR state

**API 層**：`ephemeralCreateLink()` 已支援 `prekeyBundle` 參數，**無需修改**。

**Server 端**：`create-link` handler 已將 `prekeyBundleJson` 存入 DB，**無需修改**。

### Step 2: Guest 端 — Consume 時執行 X3DH 並啟動 Key Exchange

**檔案**: `web/src/app/ui/ephemeral-ui.js`

修改 `boot()` 中 consume 成功後的流程：
```javascript
import { generateInitialBundle } from '../../../shared/crypto/prekeys.js';
import { x3dhInitiate, drEncryptText, drDecryptText } from '../../../shared/crypto/dr.js';
import { loadNacl } from '../../../shared/crypto/nacl.js';

// boot() 中 consume 成功後:
await loadNacl();
const ownerBundle = data.prekey_bundle;  // consume 回傳的 Owner 公鑰
const { devicePriv: guestPriv, bundlePub: guestBundle } = await generateInitialBundle(1, 1);

// X3DH: Guest 作為 initiator
const ownerBundleWithOpk = {
  ik_pub: ownerBundle.ik_pub,
  spk_pub: ownerBundle.spk_pub,
  spk_sig: ownerBundle.spk_sig,
  opk: ownerBundle.opks[0]  // 取第一個 OPK
};
drState = await x3dhInitiate(guestPriv, ownerBundleWithOpk);

// 透過 WS 將 Guest 的公鑰 bundle 傳送給 Owner
// Owner 需要這些資訊來完成 x3dhRespond
ws.send(JSON.stringify({
  type: 'ephemeral-key-exchange',
  sessionId: sessionState.session_id,
  guestBundle: {
    ik_pub: guestBundle.ik_pub,
    spk_pub: guestBundle.spk_pub,
    spk_sig: guestBundle.spk_sig,
    ek_pub: b64(drState.myRatchetPub),  // initiator 的 ephemeral key
    opk_id: ownerBundleWithOpk.opk.id   // 使用的 OPK ID
  }
}));
```

新增模組變數：
- `let drState = null` — Guest 的 DR state（記憶體內）
- `let keyExchangeComplete = false` — key exchange 是否完成

### Step 3: 伺服器端 — 中繼 Key Exchange 訊息

**檔案**: `data-worker/src/account-ws.js`

新增 `ephemeral-key-exchange` 和 `ephemeral-key-exchange-ack` 的中繼處理：
- 與 `ephemeral-message` 相同的路由邏輯：查 DB 找到對方 → 轉發到對方的 DO
- 伺服器不解讀 bundle 內容，純中繼

### Step 4: Owner 端 — 接收 Key Exchange 並建立 DR Session

**檔案**: `web/src/app/ui/mobile/controllers/ephemeral-controller.js`

在 `handleWsMessage()` 新增：
```javascript
import { x3dhRespond } from '../../../../shared/crypto/dr.js';

case 'ephemeral-key-exchange': {
  const session = this.ephemeralSessions.get(msg.sessionId);
  if (!session) return true;

  // 從待處理金鑰中取出此 session 對應的 Owner 私鑰
  // token 存在 session.invite_token 或需要額外映射
  const ownerPriv = this._findPrivKeyForSession(msg.sessionId);
  if (!ownerPriv) return true;  // 已無法完成 key exchange

  // X3DH: Owner 作為 responder
  const drSt = await x3dhRespond(ownerPriv, msg.guestBundle);
  this._drStates.set(msg.sessionId, drSt);

  // 回傳 ack，通知 Guest 可以開始加密通訊
  this.deps.wsSend?.({
    type: 'ephemeral-key-exchange-ack',
    sessionId: msg.sessionId,
    targetAccountDigest: session.guest_digest
  });
  return true;
}
```

### Step 5: 加密訊息收發

#### Guest 端發送（`ephemeral-ui.js`）

```javascript
// Before（明文）:
ws.send(JSON.stringify({ type: 'ephemeral-message', text, ... }));

// After（加密）:
const packet = await drEncryptText(drState, text, {
  deviceId: sessionState.guest_device_id,
  version: 1
});
ws.send(JSON.stringify({
  type: 'ephemeral-message',
  conversationId: sessionState.conversation_id,
  header: packet.header,
  iv_b64: packet.iv_b64,
  ciphertext_b64: packet.ciphertext_b64,
  ts: Date.now()
}));
```

#### Guest 端接收（`ephemeral-ui.js`）

```javascript
case 'ephemeral-message':
  if (msg.conversationId === sessionState.conversation_id) {
    // 解密
    const plaintext = await drDecryptText(drState, {
      header: msg.header,
      iv_b64: msg.iv_b64,
      ciphertext_b64: msg.ciphertext_b64
    });
    addMessage(plaintext, 'incoming', msg.ts);
  }
  break;
```

#### Owner 端發送（`ephemeral-controller.js`）

新增公開方法：
```javascript
async sendEncryptedMessage(sessionId, text) {
  const drSt = this._drStates.get(sessionId);
  if (!drSt) throw new Error('no DR state for session');
  const session = this.ephemeralSessions.get(sessionId);
  if (!session) throw new Error('session not found');

  const senderDeviceId = this.deps.ensureDeviceId?.() || '';
  const packet = await drEncryptText(drSt, text, {
    deviceId: senderDeviceId,
    version: 1
  });

  this.deps.wsSend?.({
    type: 'ephemeral-message',
    conversationId: session.conversation_id,
    header: packet.header,
    iv_b64: packet.iv_b64,
    ciphertext_b64: packet.ciphertext_b64,
    ts: Date.now()
  });
}
```

#### Owner 端接收（`ephemeral-controller.js`）

```javascript
case 'ephemeral-message': {
  const session = this.getSessionByConversationId(msg.conversationId);
  if (!session) return false;
  const drSt = this._drStates.get(session.session_id);
  if (!drSt) return false;

  const plaintext = await drDecryptText(drSt, {
    header: msg.header,
    iv_b64: msg.iv_b64,
    ciphertext_b64: msg.ciphertext_b64
  });
  // 將解密後的明文交給渲染管線
  this.deps.onEphemeralMessage?.(session.conversation_id, plaintext, msg.ts);
  return true;
}
```

### Step 6: 伺服器端中繼調整

**檔案**: `data-worker/src/account-ws.js`

修改 `_handleEphemeralMessageRelay()`:
```javascript
// Before: 轉發 msg.text（明文）
body: JSON.stringify({
  type: 'ephemeral-message',
  text: msg.text,  // ← 明文
  ...
})

// After: 轉發加密封包（伺服器看不到明文）
body: JSON.stringify({
  type: 'ephemeral-message',
  conversationId,
  header: msg.header,
  iv_b64: msg.iv_b64,
  ciphertext_b64: msg.ciphertext_b64,
  ts: msg.ts || Date.now(),
  senderDigest: senderDigest
})
```

### Step 7: 清理與銷毀

1. **Owner 端**：
   - `_deleteSession()` 時：`this._drStates.delete(sessionId)`
   - `_updateAllTimers()` 中 session 過期時：同上
   - `destroy()` 時：清除所有 `_drStates` 和 `_pendingInviteKeys`

2. **Guest 端**：
   - `destroyChat()` 時：`drState = null`（已透過模組變數重設隱式完成）
   - 加入顯式 `drState = null; keyExchangeComplete = false;`

## 不修改的部分

- **DB schema**：`prekey_bundle_json` 欄位已存在且足夠
- **加密演算法**：完全複用 `shared/crypto/dr.js` 和 `shared/crypto/prekeys.js`
- **WS 基礎設施**：繼續使用現有的 WebSocket 中繼機制
- **計時器/UI 邏輯**：不變
- **`messages_secure` 表**：ephemeral 訊息不持久化（設計如此）
- **`dr-session.js`**：不修改，ephemeral 直接使用底層 crypto

## 加密等級對照

| 面向 | 正常對話 | Ephemeral（修復後） |
|------|---------|-------------------|
| X3DH 金鑰交換 | `x3dhInitiate` / `x3dhRespond` | **相同函式** |
| DR 加密 | `drEncryptText` (AES-256-GCM) | **相同函式** |
| DR 解密 | `drDecryptText` | **相同函式** |
| AAD 驗證 | `buildDrAad` (version + deviceId + counter) | **相同機制** |
| Prekey 生成 | `generateInitialBundle` | **相同函式** |
| Ratchet 推進 | 自動 (每次 send/recv) | **相同機制** |
| State 儲存 | IndexedDB (持久化) | 記憶體 (session 結束銷毀) |
| 訊息持久化 | `messages_secure` + vault | 不持久化（ephemeral 設計） |
| 通話信令 | 明文 WS（`calls/signaling.js`） | 明文 WS（與正常對話一致，後續統一升級） |
| 通話媒體 | DTLS-SRTP | DTLS-SRTP |

## 金鑰生命週期

```
Owner 建立連結:
  generateInitialBundle(1,1) → bundlePub 存入 DB, devicePriv 存記憶體
  ↓
Guest consume (取得 Owner bundlePub):
  generateInitialBundle(1,1) → Guest 金鑰對
  x3dhInitiate(guestPriv, ownerBundle) → Guest DR state (記憶體)
  WS → 傳送 guestBundle 給 Owner
  ↓
Owner 收到 key-exchange:
  x3dhRespond(ownerPriv, guestBundle) → Owner DR state (記憶體)
  WS → 傳送 ack 給 Guest
  ↓
雙方以 DR 加密通訊（文字訊息）
通話信令維持明文 WS（與正常對話一致，後續統一升級）
  ↓
Session 過期/刪除:
  雙方清除記憶體中的 DR state
  伺服器刪除所有相關資料（messages, vault, ACL, conversation）
```

## 風險與考量

1. **Guest 重新整理頁面**：DR state 遺失，無法恢復
   - 頁面重整 = 對話終止（符合 ephemeral 設計精神）
   - 未來可考慮 `sessionStorage` 暫存（加密後），但增加複雜度

2. **Owner 重新整理頁面**：DR state 遺失
   - 需要重新 key exchange 或標記 session 失效
   - 可透過 `_pendingInviteKeys` 儲存在 `sessionStorage` 中緩解

3. **訊息順序**：DR counter 嚴格遞增，WebSocket 保證有序交付，無問題

4. **OPK 用量**：每個 ephemeral link 使用獨立產生的臨時 bundle
   - 不消耗 Owner 主帳號的 OPK pool
   - 無需 replenish

## 檔案修改清單

| 檔案 | 修改內容 |
|------|---------|
| `web/src/app/ui/mobile/controllers/ephemeral-controller.js` | 加入 prekey 生成、x3dhRespond、DR encrypt/decrypt |
| `web/src/app/ui/ephemeral-ui.js` | 加入 prekey 生成、x3dhInitiate、DR encrypt/decrypt |
| `data-worker/src/account-ws.js` | 中繼改為轉發密文封包（不含 text）、新增 key-exchange 中繼 |

## 不在本次範圍

- **通話信令加密**：正常對話也是明文 WS，後續統一升級
- **DR state 持久化**：頁面重整 = 對話終止，符合 ephemeral 設計精神

# 商業對話 — 密鑰體系與加密協議規格

> 版本：v1.0-draft | 日期：2026-03-16

---

## 一、密鑰層級總覽

```
group_seed (32 bytes, crypto.getRandomValues)
  │
  ├── group_meta_key ── HKDF-SHA256(group_seed, salt=0^32, info="sentry/biz-conv/meta-key/v1")
  │     │
  │     ├── 加密 meta blob (群組名稱、描述、avatar)
  │     ├── 加密 policy blob
  │     ├── 加密 tombstone payload
  │     └── 加密 member role blob
  │
  ├── sender_chain_key[device] ── HKDF-SHA256(group_seed, salt=0^32,
  │     │                            info="sentry/biz-conv/sender-key/v1/{epoch}/{device_id}")
  │     │
  │     └── message_key[n] ── HKDF-SHA256(sender_chain_key[n-1],
  │           │                  salt=0^32, info="sentry/biz-conv/msg-key/v1")
  │           └── AES-256-GCM 加密訊息
  │
  └── conversation_token ── HKDF-SHA256(group_seed, salt=0^32,
        │                      info="sentry/conv-token/{deviceId}")
        └── SHA-256 → conversation_id (伺服器端路由識別)
```

---

## 二、group_seed 管理

### 2.1 產生

```javascript
const groupSeed = crypto.getRandomValues(new Uint8Array(32));
```

- 每個 epoch 對應一個獨立的 group_seed
- epoch 0 的 seed 由群主在建群時產生
- epoch N+1 的 seed 在 key rotation 時由群主（或具權限者）重新產生

### 2.2 分發方式 — Key Distribution Message (KDM)

group_seed **不得** 明文傳輸或存放於伺服器。分發透過每位成員的 pairwise DR session：

```javascript
// KDM 結構（明文，透過 DR session 加密後傳輸）
const kdm = {
  v: 1,
  msg_type: 'biz-conv-kdm',
  conversation_id: '<hash>',
  epoch: 0,
  group_seed_b64: bytesToB64Url(groupSeed),
  meta: {
    name: '商業對話名稱',  // 冗餘，方便接收者立即顯示
    created_by: 'Alice'
  },
  ts: Date.now()
};

// 透過 DR session 加密發送給每位成員
for (const member of members) {
  const drSession = await loadDRSession(member.peerKey);
  const encrypted = await drEncryptText(drSession, JSON.stringify(kdm));
  await sendViaDR(member, encrypted);
}
```

### 2.3 持久化（伺服器加密 Backup）

group_seed **不存放在本地**（登出時清除所有本地資料）。
持久化透過現有的 contact_secrets_backup 機制擴展：

```javascript
// 觸發 backup：在收到 KDM 或 key rotation 後
// 將所有 group_seeds 打包進 backup payload
const backupPayload = {
  v: 1,
  // ... 現有的 contact secrets ...
  biz_conv_seeds: {
    'conv-id-1': {
      seeds: { 0: bytesToB64Url(groupSeed_epoch0) },
      current_epoch: 0,
      sender_chains: { ... }
    }
  }
};

// 以 MK 加密後上傳伺服器
const encrypted = await wrapWithMK_JSON(backupPayload, masterKeyBytes, 'biz-conv-backup/v1');
await uploadBizConvBackup(encrypted);

// 登入時：從伺服器拉取 → MK 解密 → 注水到記憶體
```

> 注意：必須在 `ALLOWED_ENVELOPE_INFO_TAGS` 中新增 `biz-conv-backup/v1`
>
> 登出時記憶體中的 group_seed 會被清除，下次登入從伺服器 backup 還原。
> 同一帳號目前只有一個 deviceId，所以不需要跨裝置同步。

---

## 三、group_meta_key 規格

### 3.1 衍生

```javascript
async function deriveGroupMetaKey(groupSeed) {
  const baseKey = await crypto.subtle.importKey(
    'raw', groupSeed, 'HKDF', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('sentry/biz-conv/meta-key/v1')
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
```

### 3.2 加密 Meta Blob

```javascript
async function encryptMetaBlob(metaKey, meta) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(meta));
  const aad = new TextEncoder().encode('sentry/biz-conv/meta/v1');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    plaintext
  );
  return {
    v: 1,
    iv_b64: bytesToB64Url(iv),
    ct_b64: bytesToB64Url(new Uint8Array(ciphertext))
  };
}
```

### 3.3 Meta Blob 明文結構

```javascript
const metaPlaintext = {
  v: 1,
  name: '我的商業群組',
  description: '可選的群組描述',
  avatar_b64: null,         // 可選的群組頭像（base64 encoded small image）
  created_by_nickname: 'Alice',
  created_at: 1710000000000
};
```

---

## 四、Sender Key Protocol

### 4.1 Sender Chain Key 衍生

每個 (epoch, device_id) 組合衍生一條獨立的 sender chain：

```javascript
async function deriveSenderChainKey(groupSeed, epoch, deviceId) {
  const baseKey = await crypto.subtle.importKey(
    'raw', groupSeed, 'HKDF', false, ['deriveBits']
  );
  const info = `sentry/biz-conv/sender-key/v1/${epoch}/${deviceId}`;
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(info)
    },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}
```

### 4.2 Chain Advancement（鏈推進）

```javascript
async function advanceSenderChain(chainKey) {
  // 衍生 message key
  const mkBase = await crypto.subtle.importKey('raw', chainKey, 'HKDF', false, ['deriveBits']);
  const mkBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('sentry/biz-conv/msg-key/v1')
    },
    mkBase, 256
  );
  const messageKey = new Uint8Array(mkBits);

  // 推進 chain key
  const ckBase = await crypto.subtle.importKey('raw', chainKey, 'HKDF', false, ['deriveBits']);
  const ckBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('sentry/biz-conv/chain-advance/v1')
    },
    ckBase, 256
  );
  const nextChainKey = new Uint8Array(ckBits);

  return { messageKey, nextChainKey };
}
```

### 4.3 訊息加密

```javascript
async function encryptBizConvMessage(groupSeed, epoch, myDeviceId, counter, plaintext) {
  // 1. 衍生 sender chain key
  let chainKey = await deriveSenderChainKey(groupSeed, epoch, myDeviceId);

  // 2. 推進 chain 至目標 counter
  let messageKey;
  for (let i = 0; i <= counter; i++) {
    const result = await advanceSenderChain(chainKey);
    messageKey = result.messageKey;
    chainKey = result.nextChainKey;
  }

  // 3. AES-256-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = buildBizConvAad({ v: 1, epoch, deviceId: myDeviceId, counter });
  const key = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    new TextEncoder().encode(JSON.stringify(plaintext))
  );

  return {
    epoch,
    sender_device_id: myDeviceId,
    counter,
    iv_b64: bytesToB64Url(iv),
    ciphertext_b64: bytesToB64Url(new Uint8Array(ct))
  };
}
```

### 4.4 AAD 結構

```javascript
function buildBizConvAad({ v = 1, epoch, deviceId, counter }) {
  // 固定格式，確保接收方能重建完全相同的 AAD
  return new TextEncoder().encode(
    `sentry/biz-conv/aad/v${v}:${epoch}:${deviceId}:${counter}`
  );
}
```

### 4.5 訊息解密

```javascript
async function decryptBizConvMessage(groupSeed, envelope) {
  const { epoch, sender_device_id, counter, iv_b64, ciphertext_b64 } = envelope;

  // 1. 衍生發送者的 sender chain key
  let chainKey = await deriveSenderChainKey(groupSeed, epoch, sender_device_id);

  // 2. 推進 chain 至目標 counter
  let messageKey;
  for (let i = 0; i <= counter; i++) {
    const result = await advanceSenderChain(chainKey);
    messageKey = result.messageKey;
    chainKey = result.nextChainKey;
  }

  // 3. AES-256-GCM 解密
  const iv = b64UrlToBytes(iv_b64);
  const ct = b64UrlToBytes(ciphertext_b64);
  const aad = buildBizConvAad({ v: 1, epoch, deviceId: sender_device_id, counter });
  const key = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key, ct
  );

  return JSON.parse(new TextDecoder().decode(plain));
}
```

### 4.6 Sender Chain State 本地快取

為避免每次都從 counter=0 重新衍生，客戶端應快取每個 (conversation_id, epoch, device_id) 的當前 chain state：

```javascript
// IndexedDB store: 'biz-conv-sender-chains'
// Key: `${conversationId}:${epoch}:${deviceId}`
// Value: { chainKey: Uint8Array, counter: Number }
```

- **發送方**：每次發送後更新自己的 chain state
- **接收方**：快取每位發送者的最新 chain state
- **亂序訊息**：如果收到 counter > 本地 counter + MAX_SKIP (100)，拒絕解密
- **跳過的 key**：快取 skipped message keys（最多 100 per chain），用於亂序到達的訊息

---

## 五、Key Rotation 協議

### 5.1 觸發條件

| 事件 | 由誰觸發 |
|------|---------|
| 成員被踢除 | 群主 |
| 成員自行離開 | 群主（收到離開通知後） |
| 群主主動輪換 | 群主 |

### 5.2 流程

```
群主 Alice:
  1. 產生新的 group_seed_N+1
  2. POST /api/v1/biz-conv/:convId/epoch  →  server 遞增 epoch
  3. 對每位剩餘 active 成員：
     - 透過 pairwise DR session 發送 KDM { epoch: N+1, group_seed_N+1 }
  4. 群組訊息（群組頻道）使用新 sender chain key

其他成員:
  1. 收到 KDM
  2. 儲存新 group_seed 至本地
  3. 衍生新的 group_meta_key 和 sender chain keys
  4. 確認 epoch 更新：POST /api/v1/biz-conv/:convId/epoch/confirm { epoch: N+1 }
  5. 後續訊息使用新 epoch 加密
```

### 5.3 Epoch 確認機制

伺服器端追蹤每位成員的 `confirmed_epoch`：
- 如果某成員的 `confirmed_epoch < current_epoch`，群主需要重新分發 KDM
- 這處理了成員離線時錯過 KDM 的情況

### 5.4 歷史訊息存取

- 客戶端保留所有曾持有的 epoch seeds
- 解密歷史訊息時，根據 `envelope.epoch` 選擇對應的 seed
- 被踢成員在離開後客戶端清除所有 seed（但無法強制執行）

---

## 六、conversation_id 衍生

複用現有的 `deriveConversationContext` 機制：

```javascript
import { deriveConversationContext } from '../../shared/conversation/context.js';

async function deriveBizConvId(groupSeed, deviceId) {
  // 與 1-to-1 使用完全相同的衍生函數
  const { conversationId, tokenB64 } = await deriveConversationContext(groupSeed, { deviceId });
  return { conversationId, tokenB64 };
}
```

> 注意：conversation_id 對伺服器而言只是一個 opaque hash，無法區分是 1-to-1 還是商業對話。
> 這是設計目標——伺服器不應知道對話類型。

---

## 七、與現有加密系統的整合點

### 7.1 AEAD 模組 (`shared/crypto/aead.js`)

新增以下 info tags 到 `ALLOWED_ENVELOPE_INFO_TAGS`：

```javascript
'biz-conv-seed/v1',    // group_seed 本地存放加密
'biz-conv-meta/v1',    // 預留，如需 wrapWithMK_JSON 格式
```

### 7.2 Conversation Context (`shared/conversation/context.js`)

- 不需修改，直接複用 `deriveConversationContext`
- 群組的 conversation_id 與 1-to-1 走相同衍生路徑

### 7.3 DR Session (`features/dr-session.js`)

- KDM 透過既有的 pairwise DR session 傳輸
- 不需修改 DR 協議本身
- 新增 `msg_type: 'biz-conv-kdm'` 到語義分類器

### 7.4 Semantic 分類 (`features/semantic.js`)

新增 message kinds：

```javascript
// USER_MESSAGE 擴展
'biz-conv-text',      // 商業對話文字訊息
'biz-conv-media',     // 商業對話媒體訊息

// CONTROL_STATE 擴展
'biz-conv-kdm',           // Key Distribution Message
'biz-conv-tombstone',     // Tombstone 事件
'biz-conv-friend-request', // 群內好友請求
```

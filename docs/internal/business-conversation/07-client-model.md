# 商業對話 — 客戶端資料模型規格

> 版本：v1.1-draft | 日期：2026-03-16

---

## 一、儲存架構

### 1.1 核心原則 — 加密回存伺服器持久化

SENTRY Messenger 的客戶端遵循 **「伺服器加密持久化 + 本地注水還原」** 模式：

- **所有持久化資料**都以 MK（Master Key）加密後回存至伺服器（D1）
- **登入時**：從伺服器拉取加密 blob → 用 MK 解密 → 注水到記憶體中
- **登出時**：清除所有本地資料（記憶體 + 任何暫存）
- **同一帳號目前只有一個 deviceId**

```
登入
  │
  ├── OPAQUE 認證 → 取得 MK
  ├── 從伺服器拉取加密的商業對話狀態
  │     ├── business_conversations → 加密 meta/policy blob
  │     ├── business_conversation_members → 加密 role blob
  │     └── contact_secrets_backup → 包含 group_seed（加密）
  ├── 用 MK 解密 → 注水到記憶體中
  └── 建立 WS 連線 → 開始接收即時事件

登出
  └── 清除所有本地資料（記憶體歸零）
```

### 1.2 不使用 IndexedDB / localStorage / sessionStorage

與舊版群組（使用 localStorage 存 draft）不同：
- **不使用 IndexedDB** 做商業對話持久化
- **不使用 localStorage / sessionStorage**
- 所有狀態都是 **記憶體 + 伺服器加密 blob**
- 登出即消失，登入時從伺服器重建

### 1.3 group_seed 的持久化

group_seed 是商業對話的核心密鑰，需要可靠持久化：

```
group_seed 持久化路徑:
  │
  ├── 方案 A: 包含在 contact_secrets_backup 中
  │     客戶端定期將所有 contact secrets（含 group_seeds）
  │     以 MK 加密後上傳至伺服器
  │     登入時拉取 → 解密 → 還原所有 group_seeds
  │
  └── 方案 B: 專用的 biz-conv-secrets-backup 端點
        類似 contact_secrets_backup 但專門存放商業對話密鑰
        { conversation_id → { group_seed, epoch, sender_chain_state } }
```

> 建議採用方案 A（複用現有 contact_secrets_backup 機制），
> 在 backup payload 中新增 `biz_conv_seeds` 區段。

---

## 二、記憶體資料結構

### 2.1 BizConvStore（記憶體 singleton）

```javascript
// 登入後注水，登出時清除
const BizConvStore = {
  // conversation_id → ConversationState
  conversations: new Map(),

  // 從伺服器加密 backup 還原
  async hydrate(masterKey, encryptedBackup) { ... },

  // 加密後回存伺服器
  async persist(masterKey) { ... },

  // 登出時清除
  clear() {
    this.conversations.clear();
  }
};
```

### 2.2 Conversation State（記憶體）

```javascript
// 存在 BizConvStore.conversations Map 中
// key: conversation_id
const conversationState = {
  conversation_id: 'SHA256-hash',
  owner_account_digest: 'hex',
  status: 'active',                    // active | dissolved

  // === 密鑰（記憶體中，不持久化到本地） ===
  seeds: {
    // epoch → group_seed (Uint8Array)
    0: Uint8Array(32),
    1: Uint8Array(32)    // key rotation 後會有多個 epoch
  },
  currentEpoch: 0,

  // 衍生的 CryptoKey（記憶體快取，可從 seed 重新衍生）
  _groupMetaKey: null,   // CryptoKey (AES-GCM)

  // === 解密後的 metadata ===
  meta: {
    name: '商業對話名稱',
    description: '描述',
    avatar_b64: null,
    created_by_nickname: 'Alice',
    created_at: 1710000000000
  },

  // === 解密後的 Policy ===
  policy: {
    v: 1,
    allow_member_invite: false,
    allow_member_friendship: true,
    max_members: 50
  },

  // === 成員列表（解密後） ===
  members: [
    {
      account_digest: 'hex',
      status: 'active',
      role: 'owner',
      nickname: 'Alice',
      confirmed_epoch: 0,
      is_friend: false
    }
  ],

  // === Sender Key Chain States ===
  senderChains: {
    // `${epoch}:${device_id}` → ChainState
    '0:my-device-id': {
      chainKey: Uint8Array(32),
      counter: 42,
      skippedKeys: new Map()  // counter → messageKey
    }
  },

  // === UI 狀態 ===
  unreadCount: 0,
  lastMessagePreview: null,
  lastSyncTs: 0
};
```

### 2.3 Sender Chain State

```javascript
const chainState = {
  chainKey: Uint8Array(32),      // 當前 chain key
  counter: 42,                   // 已發送/接收到的最新 counter

  // 跳過的 message keys（用於亂序訊息解密）
  // 最多保留 100 個，超過則丟棄最舊的
  skippedKeys: new Map([
    // [counter, messageKey]
    [38, Uint8Array(32)],
    [40, Uint8Array(32)]
  ])
};
```

---

## 三、伺服器端加密 Backup 結構

### 3.1 商業對話密鑰 Backup

擴展現有的 contact_secrets_backup 機制：

```javascript
// 回存至伺服器的加密 payload（以 MK 加密）
const bizConvBackupPayload = {
  v: 1,
  conversations: {
    'conv-id-1': {
      seeds: {
        0: 'base64url(group_seed_epoch_0)',
        1: 'base64url(group_seed_epoch_1)'
      },
      current_epoch: 1,
      sender_chains: {
        '1:my-device-id': {
          chain_key_b64: 'base64url(chain_key)',
          counter: 42
          // skipped_keys 不回存（體積太大且短期有效）
        }
      }
    }
  },
  updated_at: 1710000000000
};

// 加密並上傳
const encrypted = await wrapWithMK_JSON(bizConvBackupPayload, masterKey, 'biz-conv-backup/v1');
await uploadBizConvBackup(encrypted);
```

### 3.2 Backup 觸發時機

```javascript
// 以下事件觸發 backup：
// 1. 建立/加入商業對話（收到 KDM）
// 2. Key Rotation（收到新 epoch seed）
// 3. 定期備份（例如每 5 分鐘，如有變更）
// 4. 應用程式進入背景前

async function triggerBizConvBackup() {
  if (!bizConvBackupDirty) return;
  const payload = buildBizConvBackupPayload();
  const encrypted = await wrapWithMK_JSON(payload, masterKey, 'biz-conv-backup/v1');
  await uploadBizConvBackup(encrypted);
  bizConvBackupDirty = false;
}
```

### 3.3 登入還原流程

```javascript
async function hydrateOnLogin(masterKey) {
  // 1. 拉取加密的商業對話 backup
  const encryptedBackup = await fetchBizConvBackup();
  if (!encryptedBackup) return; // 無商業對話資料

  // 2. 解密
  const backup = await unwrapWithMK_JSON(encryptedBackup, masterKey);

  // 3. 注水到記憶體
  for (const [convId, convData] of Object.entries(backup.conversations)) {
    const state = createConversationState(convId);

    // 還原 seeds
    for (const [epoch, seedB64] of Object.entries(convData.seeds)) {
      state.seeds[Number(epoch)] = b64UrlToBytes(seedB64);
    }
    state.currentEpoch = convData.current_epoch;

    // 衍生 groupMetaKey
    const currentSeed = state.seeds[state.currentEpoch];
    state._groupMetaKey = await deriveGroupMetaKey(currentSeed);

    // 還原 sender chain states
    for (const [key, chain] of Object.entries(convData.sender_chains || {})) {
      state.senderChains[key] = {
        chainKey: b64UrlToBytes(chain.chain_key_b64),
        counter: chain.counter,
        skippedKeys: new Map()
      };
    }

    BizConvStore.conversations.set(convId, state);
  }

  // 4. 從伺服器拉取加密 meta/policy blob 並解密
  for (const [convId, state] of BizConvStore.conversations) {
    const convInfo = await apiBizConvGet(convId);
    if (convInfo.status === 'dissolved') {
      BizConvStore.conversations.delete(convId);
      continue;
    }
    state.owner_account_digest = convInfo.owner_account_digest;
    state.status = convInfo.status;
    state.meta = await decryptMetaBlob(state._groupMetaKey, convInfo.encrypted_meta_blob);
    state.policy = await decryptPolicy(state._groupMetaKey, convInfo.encrypted_policy_blob);

    // 拉取成員列表
    const { members } = await apiBizConvMembers(convId);
    state.members = members.map(m => ({
      account_digest: m.account_digest,
      status: m.status,
      confirmed_epoch: m.confirmed_epoch,
      ...decryptRoleBlob(state._groupMetaKey, m.encrypted_role_blob)
    }));
  }
}
```

---

## 四、對話列表整合

### 4.1 conversation-updates.js 擴展

現有的對話列表僅支援 1-to-1。商業對話需要整合：

```javascript
// 對話列表項目結構（擴展）
const conversationThread = {
  // 共通欄位
  conversationId: 'SHA256-hash',
  type: 'biz-conv',               // 新增：'dm' | 'biz-conv'
  lastMessage: { preview: '...', ts: 1710000000000 },
  unreadCount: 3,
  updatedAt: 1710000000000,

  // 商業對話特有欄位
  bizConv: {
    name: '商業對話名稱',
    memberCount: 5,
    isOwner: false,
    status: 'active'
  },

  // 1-to-1 特有欄位（null for biz-conv）
  peerKey: null,
  peerNickname: null
};
```

### 4.2 排序規則

商業對話與 1-to-1 對話混合排序，按最後訊息時間降序：

```javascript
function sortConversationThreads(threads) {
  return threads.sort((a, b) => {
    const tsA = a.lastMessage?.ts || a.updatedAt || 0;
    const tsB = b.lastMessage?.ts || b.updatedAt || 0;
    return tsB - tsA;
  });
}
```

---

## 五、Timeline Store 擴展

### 5.1 timeline-store.js 整合

```javascript
// 現有 USER_MESSAGE_TYPES 擴展
const USER_MESSAGE_TYPES = new Set([
  'TEXT', 'MEDIA', 'CALL_LOG', 'PLACEHOLDER', 'SYSTEM',
  'CONVERSATION_DELETED', 'CONTACT_SHARE',
  // 新增
  'BIZ_CONV_TEXT',
  'BIZ_CONV_MEDIA',
  'BIZ_CONV_TOMBSTONE'
]);
```

### 5.2 Tombstone 在 Timeline 中的表示

```javascript
const tombstoneTimelineEntry = {
  id: 'tombstone-uuid',
  conversationId: 'SHA256-hash',
  type: 'BIZ_CONV_TOMBSTONE',
  content: {
    tombstone_type: 'friend_added',
    message: 'Alice 已經與 Bob 透過群組成為好友'
  },
  ts: 1710000000000,
  isSystem: true
};
```

---

## 六、Messages Flow 整合

### 6.1 messages-flow/hybrid-flow.js 擴展

```javascript
// 訊息接收決策樹
function classifyIncomingMessage(envelope) {
  if (envelope.type === 'biz-conv-message') {
    return 'BIZ_CONV';          // 走 Sender Key 解密路徑
  }
  if (envelope.type === 'secure-message') {
    return 'DM';                // 走 DR 解密路徑
  }
  // ...
}
```

### 6.2 發送流程

```javascript
async function processBizConvOutboxItem(item) {
  const { conversationId, plaintext } = item;

  // 1. 取得記憶體中的 session state
  const state = BizConvStore.conversations.get(conversationId);
  if (!state) throw new Error('No active session');

  // 2. Sender Key 加密
  const myChainKey = `${state.currentEpoch}:${myDeviceId}`;
  const chain = state.senderChains[myChainKey];
  const envelope = await encryptBizConvMessage(
    state.seeds[state.currentEpoch],
    state.currentEpoch,
    myDeviceId,
    chain.counter,
    plaintext
  );

  // 3. 更新 chain state
  chain.counter++;

  // 4. 透過 WS 發送
  ws.send(JSON.stringify({
    type: 'biz-conv-message',
    conversation_id: conversationId,
    message_id: crypto.randomUUID(),
    ...envelope
  }));

  // 5. 標記需要 backup
  bizConvBackupDirty = true;
}
```

---

## 七、清除策略

### 7.1 登出時

```javascript
async function cleanupOnLogout() {
  // 清除記憶體中的所有商業對話狀態
  BizConvStore.clear();

  // 所有密鑰（group_seed, meta_key, chain_key）隨記憶體清除
  // 下次登入時從伺服器加密 backup 重建
}
```

### 7.2 成員離開/被踢時

```javascript
async function cleanupAfterLeave(conversationId) {
  // 1. 從記憶體移除該對話的所有密鑰
  BizConvStore.conversations.delete(conversationId);

  // 2. 更新伺服器端 backup（移除該對話的 seed 資料）
  bizConvBackupDirty = true;
  await triggerBizConvBackup();

  // 3. UI 上隱藏對話（但不刪除伺服器端的對話記錄）
}
```

### 7.3 群組解散時

```javascript
async function cleanupAfterDissolve(conversationId) {
  // 1. 從記憶體完全移除
  BizConvStore.conversations.delete(conversationId);

  // 2. 更新伺服器端 backup
  bizConvBackupDirty = true;
  await triggerBizConvBackup();

  // 3. 伺服器已硬刪除所有資料（由 owner 的 dissolve API 觸發）
  // 4. UI 上移除對話
}
```

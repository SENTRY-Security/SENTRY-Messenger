# SENTRY Messenger — 商業對話 (Business Conversation) 架構設計

> 版本：v1.0-draft
> 日期：2026-03-16
> 取代：舊版群組功能（已全部移除）

---

## 一、設計原則

### 1.1 零信任伺服器

伺服器僅作為密文路由與 ACL 閘道，**不得知曉任何對話 metadata**：

| 資料 | 伺服器可見 | 伺服器不可見 |
|------|-----------|-------------|
| conversation_id | SHA-256 衍生 hash | 原始 shared secret |
| 群組名稱 | encrypted blob | 明文名稱 |
| Policy | encrypted blob | Policy 內容 |
| 成員角色 | encrypted blob | 角色語義（owner/member） |
| 訊息內容 | ciphertext | 明文 |
| Tombstone 內容 | encrypted blob | 事件描述 |

### 1.2 加密優先

- 所有 metadata（群組名稱、Policy、成員暱稱、tombstone）皆以 **group_meta_key** 加密存放
- `group_meta_key` 由 group secret 衍生，僅成員持有
- 成員異動時執行 **key rotation**

### 1.3 最小資料面

- 伺服器端不儲存任何可逆推群組語義的欄位
- 角色、踢人、邀請權限等全部在 encrypted policy blob 中
- 即使 DB 全部外洩，攻擊者只能看到 opaque blobs + conversation_id hashes

---

## 二、密鑰體系

```
group_seed (32 bytes, random)
  │
  ├─ HKDF(info="sentry/biz-conv/meta-key/v1")
  │   └─ group_meta_key (256-bit AES-GCM)
  │       ├─ 加密群組名稱
  │       ├─ 加密 Policy blob
  │       ├─ 加密 Tombstone 內容
  │       └─ 加密成員角色 blob
  │
  ├─ HKDF(info="sentry/biz-conv/sender-key/v1/{epoch}")
  │   └─ sender_chain_key (per-epoch)
  │       └─ 各成員的 Sender Key chain（訊息加密）
  │
  └─ HKDF(info="sentry/conv-token/{deviceId}")
      └─ conversation_token → SHA-256 → conversation_id
          └─ 伺服器端路由識別
```

### 2.1 Key Rotation（密鑰輪換）

觸發條件：
- 成員被踢除
- 成員自行離開
- 群主主動觸發

輪換流程：
1. 群主（或具權限者）產生新的 `group_seed_epoch_N+1`
2. 透過每位剩餘成員的 **pairwise DR session** 個別分發新 seed
3. 新 seed 衍生新的 `group_meta_key` 和 `sender_chain_key`
4. 舊 epoch 的 key 保留在客戶端用於解密歷史訊息
5. 伺服器端僅知道 epoch 遞增

```
Key Distribution Message (KDM):
{
  "type": "biz-conv-key-rotation",
  "epoch": 2,
  "group_conv_id": "...",
  "encrypted_seed": "<per-recipient DR encrypted new group_seed>"
}
```

### 2.2 Sender Key Protocol

群組訊息使用 **Sender Key** 模型（類似 Signal 的 Group Session）：

```
發送者 Alice:
  1. sender_chain_key[epoch] = HKDF(group_seed, info="sentry/biz-conv/sender-key/v1/{epoch}/{alice_device_id}")
  2. message_key[n] = HKDF(sender_chain_key, info="msg/{n}")
  3. sender_chain_key = HKDF(sender_chain_key, info="chain-advance")
  4. ciphertext = AES-256-GCM(message_key[n], iv, plaintext, aad)
  5. envelope = { epoch, sender_device_id, counter: n, iv_b64, ct_b64 }
```

所有群組成員持有相同 `group_seed`，可獨立衍生每位成員的 sender_chain_key。

---

## 三、資料庫 Schema（伺服器端 D1）

### 3.1 business_conversations（取代 groups）

```sql
CREATE TABLE IF NOT EXISTS business_conversations (
  -- 由 group_seed 衍生的 conversation_id（SHA-256 hash，伺服器不知道 seed）
  conversation_id TEXT PRIMARY KEY,

  -- 群主的 account_digest（僅用於 ACL 判斷，不洩漏群組語義）
  owner_account_digest TEXT NOT NULL,

  -- 加密的群組 metadata blob（名稱、描述、avatar 等，用 group_meta_key 加密）
  encrypted_meta_blob TEXT,

  -- 加密的 Policy blob（用 group_meta_key 加密）
  encrypted_policy_blob TEXT,

  -- 當前密鑰 epoch（僅數字，不洩漏語義）
  key_epoch INTEGER NOT NULL DEFAULT 0,

  -- 狀態：active / dissolved
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'dissolved')),

  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),

  FOREIGN KEY (owner_account_digest)
    REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_biz_conv_owner
  ON business_conversations(owner_account_digest);
CREATE INDEX IF NOT EXISTS idx_biz_conv_status
  ON business_conversations(status);
```

### 3.2 business_conversation_members（取代 group_members）

```sql
CREATE TABLE IF NOT EXISTS business_conversation_members (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,

  -- 加密的角色 blob（用 group_meta_key 加密，內含 role 等資訊）
  -- 伺服器不知道此人是 owner/admin/member
  encrypted_role_blob TEXT,

  -- 成員狀態（伺服器可見，用於 ACL 過濾）
  -- active: 正常成員
  -- left: 自行離開
  -- removed: 被踢除
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'left', 'removed')),

  -- 該成員最後確認的 key epoch（用於判斷是否需要補發 key）
  confirmed_epoch INTEGER NOT NULL DEFAULT 0,

  -- 邀請者（可選，用於追蹤誰邀請了誰）
  inviter_account_digest TEXT,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),

  PRIMARY KEY (conversation_id, account_digest),
  FOREIGN KEY (conversation_id)
    REFERENCES business_conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (account_digest)
    REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_biz_conv_members_account
  ON business_conversation_members(account_digest);
CREATE INDEX IF NOT EXISTS idx_biz_conv_members_status
  ON business_conversation_members(conversation_id, status);
```

### 3.3 business_conversation_tombstones

```sql
CREATE TABLE IF NOT EXISTS business_conversation_tombstones (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,

  -- Tombstone 類型（伺服器可見，用於排序/篩選）
  -- member_joined, member_left, member_removed, ownership_transferred,
  -- policy_changed, friend_added, conversation_dissolved
  tombstone_type TEXT NOT NULL,

  -- 加密的事件描述（用 group_meta_key 加密）
  -- 內含「AAA 已經與 BBB 透過群組成為好友」等可讀文字
  encrypted_payload_blob TEXT NOT NULL,

  -- 關聯的 account_digest（用於 ACL 查詢）
  actor_account_digest TEXT,

  -- 事件時的 key epoch
  key_epoch INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),

  FOREIGN KEY (conversation_id)
    REFERENCES business_conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_biz_conv_tombstones_conv
  ON business_conversation_tombstones(conversation_id, created_at DESC);
```

### 3.4 conversation_acl 複用

現有的 `conversation_acl` 表可直接複用，群組的 conversation_id 會被加入 ACL：

```sql
-- 既有表，不需修改
-- conversation_acl (conversation_id, account_digest, device_id, role, ...)
```

### 3.5 舊表移除

以下表在新 migration 中 **DROP**：
- `groups`
- `group_members`
- `group_invites`

---

## 四、Policy 系統

### 4.1 Policy 結構（客戶端明文，伺服器端加密存放）

```javascript
// Policy 由群主設定，用 group_meta_key 加密後存入 encrypted_policy_blob
const policy = {
  v: 1,                          // Policy 版本
  allow_member_invite: false,    // 成員是否可邀請他人加入
  allow_member_friendship: true, // 成員間是否可互加好友
  max_members: 50,               // 最大成員數
  // 未來擴展欄位...
};
```

### 4.2 Policy 變更流程

```
群主修改 Policy
  │
  ├─ 客戶端: 用 group_meta_key 加密新 Policy blob
  │
  ├─ POST /api/v1/biz-conv/:convId/policy
  │   { encrypted_policy_blob }
  │
  ├─ 伺服器: 驗證操作者為 owner_account_digest → 更新 blob
  │
  ├─ 廣播 WebSocket 事件: { type: "biz-conv-policy-updated", conversation_id }
  │
  └─ 各成員收到後下載新 blob → 用 group_meta_key 解密 → 更新本地 Policy
```

### 4.3 Policy 校驗

Policy 的執行分為兩層：
- **伺服器端**：僅做 ACL 檢查（是否為成員、是否為 owner）
- **客戶端**：解密 Policy 後做完整校驗（是否允許邀請、是否允許互加好友等）

> 設計取捨：伺服器無法校驗 Policy 內容（因為是加密的），所以惡意客戶端理論上可以繞過 Policy。
> 但這符合 zero-trust 原則——伺服器不參與業務邏輯判斷，只做身份驗證和路由。
> 未來可考慮「Policy hash commitment」方案來增加可驗證性。

---

## 五、核心操作流程

### 5.1 建立商業對話

```
群主 (Alice)                                Server                        成員 (Bob, Carol)
────────────                                ──────                        ─────────────────
  │ 產生 group_seed (32 bytes)                │                               │
  │ 衍生 group_meta_key                       │                               │
  │ 衍生 conversation_id                      │                               │
  │ 加密 meta_blob (名稱等)                    │                               │
  │ 加密 policy_blob                          │                               │
  │                                           │                               │
  │── POST /api/v1/biz-conv/create ─────────▶│                               │
  │   { conversation_id,                      │                               │
  │     encrypted_meta_blob,                  │── 建立 business_conversations  │
  │     encrypted_policy_blob,                │── 建立 owner member record    │
  │     members: [bob_digest, carol_digest] } │── 建立 member records         │
  │                                           │── 建立 conversation_acl       │
  │◀── { ok: true } ─────────────────────────│                               │
  │                                           │                               │
  │── 透過 Bob 的 DR session 發送 ──────────▶ │ ─── WS push ───────────────▶ │
  │   KDM { group_seed, epoch: 0,             │                               │ Bob 解密 KDM
  │         conversation_id, meta }           │                               │ 衍生 group_meta_key
  │                                           │                               │ 解密 meta + policy
  │── 透過 Carol 的 DR session 發送 ─────────▶│ ─── WS push ───────────────▶ │
  │   KDM { group_seed, epoch: 0,             │                               │ Carol 同上
  │         conversation_id, meta }           │                               │
```

### 5.2 群主身份轉移

```
Alice (current owner)                       Server                        Bob (new owner)
─────────────────────                       ──────                        ────────────────
  │── POST /api/v1/biz-conv/:id/transfer ──▶│                               │
  │   { new_owner: bob_digest }              │                               │
  │                                          │── 驗證 Alice 是 owner         │
  │                                          │── 更新 owner_account_digest   │
  │                                          │── 建立 tombstone              │
  │◀── { ok: true } ────────────────────────│                               │
  │                                          │                               │
  │── 透過群組通道發送加密 tombstone ─────────▶│ ─── WS 廣播 ───────────────▶│
  │   { type: "ownership_transferred",       │                               │
  │     from: "Alice", to: "Bob" }           │                               │
  │                                          │                               │
  │── 透過 Bob DR session 發送新 Policy ─────▶│                               │
  │   (Bob 現在可修改 Policy)                 │                               │
```

### 5.3 邀請成員

```
根據 Policy.allow_member_invite 決定誰可以邀請：

if allow_member_invite == true:
  任何 active 成員都可以邀請
else:
  僅 owner 可以邀請

邀請者 (Alice)                              Server                        被邀請者 (Dave)
──────────────                              ──────                        ───────────────
  │── POST /api/v1/biz-conv/:id/invite ────▶│                               │
  │   { invitee: dave_digest }               │                               │
  │                                          │── 驗證 Alice 是 active 成員   │
  │                                          │── 建立 Dave member record     │
  │                                          │── 建立 Dave ACL               │
  │◀── { ok: true } ────────────────────────│                               │
  │                                          │                               │
  │── 透過 Dave 的 DR session 發送 KDM ─────▶│ ─── WS push ──────────────▶  │
  │   { group_seed, epoch, conv_id, meta }   │                               │ 解密 KDM
  │                                          │                               │ 加入對話
  │── 群組 tombstone: "Dave 已加入" ─────────▶│ ─── WS 廣播 ──────────────▶  │
```

### 5.4 踢除成員

```
群主 (Alice)                                Server                        被踢者 (Eve)
────────────                                ──────                        ─────────────
  │── POST /api/v1/biz-conv/:id/remove ────▶│                               │
  │   { target: eve_digest }                 │                               │
  │                                          │── 驗證 Alice 是 owner         │
  │                                          │── 更新 Eve status = removed   │
  │                                          │── 移除 Eve ACL                │
  │                                          │── 建立 tombstone              │
  │◀── { ok: true } ────────────────────────│                               │
  │                                          │── WS 通知 Eve: removed ─────▶│
  │                                          │                               │ Eve 清除本地對話資料
  │                                          │                               │
  │── Key Rotation (epoch N+1) ─────────────│                               │
  │   透過每位剩餘成員 DR session 發送新 seed │                               │
  │── 群組 tombstone: "Eve 已被移除" ────────▶│ ─── WS 廣播 ──────────────▶  │
```

### 5.5 成員離開

```
成員 (Bob)                                  Server
──────────                                  ──────
  │── POST /api/v1/biz-conv/:id/leave ────▶│
  │                                         │── 驗證 Bob 是 active 成員
  │                                         │── 驗證 Bob 不是 owner（owner 不能離開，必須先轉移）
  │                                         │── 更新 Bob status = left
  │                                         │── 移除 Bob ACL
  │                                         │── 建立 tombstone
  │◀── { ok: true } ───────────────────────│
  │                                         │── WS 廣播 tombstone ─────────▶ 其他成員
  │ 清除本地對話資料                          │
  │                                         │── 通知 owner 執行 Key Rotation
```

> 注意：成員只能「離開」，**不能刪除群組對話**。對話記錄在離開後由客戶端從 UI 中隱藏，但不會從伺服器刪除（其他成員仍可看到）。

### 5.6 群主解散群組

```
群主 (Alice)                                Server
────────────                                ──────
  │── POST /api/v1/biz-conv/:id/dissolve ─▶│
  │                                         │── 驗證 Alice 是 owner
  │                                         │── WS 廣播: conversation_dissolved
  │                                         │── 硬刪除:
  │                                         │     DELETE FROM messages_secure WHERE conversation_id = ?
  │                                         │     DELETE FROM attachments WHERE conversation_id = ?
  │                                         │     DELETE FROM business_conversation_tombstones WHERE conversation_id = ?
  │                                         │     DELETE FROM business_conversation_members WHERE conversation_id = ?
  │                                         │     DELETE FROM conversation_acl WHERE conversation_id = ?
  │                                         │     DELETE FROM business_conversations WHERE conversation_id = ?
  │◀── { ok: true } ───────────────────────│
  │                                         │
  │ 清除本地所有相關資料                      │ 所有成員收到 WS 通知後清除本地資料
```

### 5.7 群內互加好友

```
前提：Policy.allow_member_friendship == true

成員 A                                      Server / 群組通道                成員 B
──────                                      ───────────────                 ──────
  │── 透過群組通道發送好友請求 ────────────────▶│                               │
  │   (加密訊息: friend_request)               │── WS 轉發 ──────────────────▶│
  │                                            │                              │ 解密，顯示好友請求
  │                                            │◀── 接受（加密回應）───────────│
  │◀── WS 轉發 ───────────────────────────────│                              │
  │                                            │                              │
  │ 雙方開始一般的 invite-dropbox 好友建立流程    │                              │
  │ (X3DH → DR session → 新的 1-to-1 對話)     │                              │
  │                                            │                              │
  │── 群組 tombstone ─────────────────────────▶│── WS 廣播 ─────────────────▶│
  │   "A 已經與 B 透過群組成為好友"              │                              │
```

---

## 六、API 端點設計

### 6.1 商業對話 CRUD

| Method | Path | 權限 | 說明 |
|--------|------|------|------|
| POST | `/api/v1/biz-conv/create` | 已登入用戶 | 建立商業對話 |
| GET | `/api/v1/biz-conv/:convId` | 成員 | 取得對話資訊（加密 blob） |
| PUT | `/api/v1/biz-conv/:convId/meta` | owner | 更新加密 meta blob |
| PUT | `/api/v1/biz-conv/:convId/policy` | owner | 更新加密 policy blob |
| POST | `/api/v1/biz-conv/:convId/dissolve` | owner | 解散（硬刪除） |

### 6.2 成員管理

| Method | Path | 權限 | 說明 |
|--------|------|------|------|
| POST | `/api/v1/biz-conv/:convId/invite` | owner 或成員（依 policy） | 邀請成員 |
| POST | `/api/v1/biz-conv/:convId/remove` | owner | 踢除成員 |
| POST | `/api/v1/biz-conv/:convId/leave` | 成員（非 owner） | 離開群組 |
| POST | `/api/v1/biz-conv/:convId/transfer` | owner | 轉移群主 |
| GET | `/api/v1/biz-conv/:convId/members` | 成員 | 取得成員列表 |

### 6.3 Tombstone

| Method | Path | 權限 | 說明 |
|--------|------|------|------|
| POST | `/api/v1/biz-conv/:convId/tombstone` | 成員 | 新增 tombstone |
| GET | `/api/v1/biz-conv/:convId/tombstones` | 成員 | 取得 tombstone 列表 |

### 6.4 Key Epoch

| Method | Path | 權限 | 說明 |
|--------|------|------|------|
| POST | `/api/v1/biz-conv/:convId/epoch` | owner | 遞增 epoch |
| GET | `/api/v1/biz-conv/:convId/epoch` | 成員 | 查詢當前 epoch |

---

## 七、WebSocket 事件

```javascript
// 群組相關 WS 事件類型
const BIZ_CONV_WS_EVENTS = {
  // 群組訊息（Sender Key 加密）
  'biz-conv-message': {
    conversation_id: String,
    sender_account_digest: String,
    sender_device_id: String,
    epoch: Number,
    counter: Number,
    iv_b64: String,
    ciphertext_b64: String,
    ts: Number
  },

  // 成員變動通知
  'biz-conv-member-changed': {
    conversation_id: String,
    action: 'joined' | 'left' | 'removed',
    account_digest: String,
    tombstone_id: String
  },

  // Policy 更新通知
  'biz-conv-policy-updated': {
    conversation_id: String,
    epoch: Number
  },

  // 群主轉移通知
  'biz-conv-ownership-transferred': {
    conversation_id: String,
    new_owner_account_digest: String,
    tombstone_id: String
  },

  // 群組解散通知
  'biz-conv-dissolved': {
    conversation_id: String
  },

  // Key Rotation 通知（提醒成員檢查新的 KDM）
  'biz-conv-key-rotated': {
    conversation_id: String,
    new_epoch: Number
  }
};
```

---

## 八、Tombstone 類型定義

```javascript
const TOMBSTONE_TYPES = {
  MEMBER_JOINED: 'member_joined',
  MEMBER_LEFT: 'member_left',
  MEMBER_REMOVED: 'member_removed',
  OWNERSHIP_TRANSFERRED: 'ownership_transferred',
  POLICY_CHANGED: 'policy_changed',
  FRIEND_ADDED: 'friend_added',         // "{A} 已經與 {B} 透過群組成為好友"
  CONVERSATION_DISSOLVED: 'conversation_dissolved'
};

// Tombstone encrypted payload 結構
const tombstonePayload = {
  v: 1,
  type: 'friend_added',
  actor: 'Alice',           // 操作者暱稱（加密，僅成員可見）
  target: 'Bob',            // 目標暱稱（加密，僅成員可見）
  message: 'Alice 已經與 Bob 透過群組成為好友',  // 人類可讀描述
  ts: 1710000000000
};
```

---

## 九、客戶端資料模型

### 9.1 本地儲存（IndexedDB）

```javascript
// 商業對話本地快取
const BizConversationStore = {
  // conversation_id → { group_seed, epoch, meta, policy, members, ... }
  conversations: IndexedDB('biz-conversations'),

  // Sender Key chain states
  senderKeys: IndexedDB('biz-conv-sender-keys'),

  // 歷史 epoch seeds（用於解密歷史訊息）
  epochSeeds: IndexedDB('biz-conv-epoch-seeds')
};
```

### 9.2 敏感資料保護

- `group_seed` 和 `group_meta_key` 以使用者 MK 加密後存入 IndexedDB
- 不使用 localStorage/sessionStorage 存放任何群組密鑰
- 密鑰僅在記憶體中解密使用，用完即丟

---

## 十、訊息流整合

### 10.1 發送群組訊息

```javascript
async function sendBizConvMessage(conversationId, plaintext) {
  // 1. 從本地取得 group_seed 和 epoch
  const { groupSeed, epoch } = await BizConversationStore.get(conversationId);

  // 2. 衍生 sender chain key
  const senderChainKey = await deriveSenderChainKey(groupSeed, epoch, myDeviceId);

  // 3. 推進 chain，取得 message key
  const { messageKey, counter, newChainKey } = advanceSenderChain(senderChainKey);

  // 4. AES-256-GCM 加密
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = buildBizConvAad({ epoch, deviceId: myDeviceId, counter });
  const ciphertext = await aeadEncrypt(messageKey, iv, plaintext, aad);

  // 5. 透過 WS 或 HTTP 發送
  await send({
    type: 'biz-conv-message',
    conversation_id: conversationId,
    epoch, counter,
    sender_device_id: myDeviceId,
    iv_b64: bytesToB64Url(iv),
    ciphertext_b64: bytesToB64Url(ciphertext)
  });

  // 6. 更新本地 chain state
  await BizConversationStore.updateSenderChain(conversationId, newChainKey, counter);
}
```

### 10.2 接收群組訊息

```javascript
async function receiveBizConvMessage(envelope) {
  const { conversation_id, epoch, counter, sender_device_id, iv_b64, ciphertext_b64 } = envelope;

  // 1. 取得對應 epoch 的 group_seed
  const groupSeed = await BizConversationStore.getEpochSeed(conversation_id, epoch);

  // 2. 衍生發送者的 sender chain key
  const senderChainKey = await deriveSenderChainKey(groupSeed, epoch, sender_device_id);

  // 3. 推進至目標 counter，取得 message key
  const messageKey = await advanceToCounter(senderChainKey, counter);

  // 4. AES-256-GCM 解密
  const aad = buildBizConvAad({ epoch, deviceId: sender_device_id, counter });
  const plaintext = await aeadDecrypt(messageKey, b64UrlToBytes(iv_b64), b64UrlToBytes(ciphertext_b64), aad);

  return plaintext;
}
```

---

## 十一、實作階段規劃

### Phase 1 — 基礎架構（本次）

1. 移除舊群組程式碼（DB schema 中的 groups/group_members/group_invites、worker endpoints、前端 API/feature/UI）
2. 建立新 DB migration（business_conversations、business_conversation_members、business_conversation_tombstones）
3. 建立 worker 端 CRUD endpoints（含 ACL 驗證）
4. 建立前端 API wrapper

### Phase 2 — 加密通訊

5. 實作 group_seed 衍生和 group_meta_key 加密
6. 實作 Sender Key 協議（加解密）
7. 實作 Key Distribution Message（透過 pairwise DR session）
8. 實作 Key Rotation 機制
9. 整合至 messages-flow pipeline

### Phase 3 — 群組管理

10. 實作 Policy 系統
11. 實作群主轉移
12. 實作成員邀請/踢除/離開
13. 實作 Tombstone 系統

### Phase 4 — 好友功能

14. 實作群內互加好友流程
15. 實作 Policy 控制（allow_member_friendship）
16. 整合 invite-dropbox 好友流程

### Phase 5 — UI

17. 建立商業對話建立 UI
18. 建立商業對話聊天 UI
19. 整合至對話列表
20. Tombstone 顯示

---

## 十二、安全考量

### 12.1 威脅模型

| 攻擊者 | 可得到什麼 | 無法得到什麼 |
|--------|-----------|-------------|
| 入侵伺服器 DB | 加密 blob、conversation_id hash、成員 account_digest | 群組名稱、Policy、訊息明文、成員角色 |
| 竊聽網路 | TLS 密文 | 任何明文 |
| 被踢成員 | 踢除前的歷史訊息（持有舊 epoch key） | 踢除後的新訊息（新 epoch key 未分發） |
| 惡意客戶端 | 可繞過 Policy（客戶端執行） | 無法冒充其他成員（DR session 綁定身份） |

### 12.2 已知限制

1. **伺服器可見成員 account_digest**：這是 ACL 必需，無法避免。攻擊者可知道「誰在同一個 conversation_id 裡」，但不知道那是什麼群組。
2. **Policy 僅客戶端執行**：惡意客戶端可以忽略 Policy 限制。未來可透過 Policy hash commitment 改善。
3. **被踢成員的前向安全**：被踢者仍持有舊 epoch 的 key，可解密踢除前的歷史訊息。這是 Sender Key 協議的固有限制。
4. **owner 單點風險**：目前 owner 是唯一可執行管理操作的角色。未來可擴展為 admin 角色。

### 12.3 與現有 1-to-1 加密的差異

| | 1-to-1 (DR) | 商業對話 (Sender Key) |
|--|---|---|
| 前向安全 | 每條訊息 | 每次 Key Rotation |
| 密鑰分發 | X3DH（一次性） | KDM via DR（每次 rotation） |
| 成員異動 | N/A | Key Rotation |
| 訊息加密 | Per-recipient DR | 共享 Sender Key chain |
| 效能 | O(1) per message | O(1) per message, O(N) per rotation |

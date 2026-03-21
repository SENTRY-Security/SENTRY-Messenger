# 商業對話 — API 端點規格

> 版本：v1.0-draft | 日期：2026-03-16

---

## 一、認證與授權

所有端點都需要帳號認證（同現有的 `resolvePublicAuth` / `resolveAccountAuth`）。

額外的授權層：
- **成員檢查**：驗證操作者為該商業對話的 active 成員
- **群主檢查**：驗證操作者為 `owner_account_digest`

```javascript
// 授權中間件（worker.js 中實作）
async function requireBizConvMember(env, conversationId, accountDigest) {
  const row = await env.DB.prepare(
    `SELECT status FROM business_conversation_members
     WHERE conversation_id = ?1 AND account_digest = ?2`
  ).bind(conversationId, accountDigest).first();
  if (!row || row.status !== 'active') {
    throw { status: 403, error: 'NotMember' };
  }
}

async function requireBizConvOwner(env, conversationId, accountDigest) {
  const row = await env.DB.prepare(
    `SELECT owner_account_digest FROM business_conversations
     WHERE conversation_id = ?1 AND status = 'active'`
  ).bind(conversationId).first();
  if (!row || row.owner_account_digest !== accountDigest) {
    throw { status: 403, error: 'NotOwner' };
  }
}
```

---

## 二、商業對話 CRUD

### 2.1 POST /api/v1/biz-conv/create

建立新的商業對話。

**Request:**
```json
{
  "conversation_id": "<SHA-256 derived hash>",
  "encrypted_meta_blob": "{ v, iv_b64, ct_b64 }",
  "encrypted_policy_blob": "{ v, iv_b64, ct_b64 }",
  "members": [
    { "account_digest": "..." },
    { "account_digest": "..." }
  ]
}
```

**處理邏輯:**
1. 驗證帳號認證
2. 建立 `business_conversations` 記錄（caller 為 owner）
3. 建立 caller 的 `business_conversation_members` 記錄（status: active）
4. 建立 `conversation_acl` 記錄（caller + 所有成員）
5. 為每位 member 建立 `business_conversation_members` 記錄
6. 建立 `member_joined` tombstone（每位成員各一個）

**Response (200):**
```json
{
  "ok": true,
  "conversation_id": "...",
  "key_epoch": 0,
  "members_count": 3
}
```

**Error Responses:**
- 400: conversation_id 或 members 缺失
- 409: conversation_id 已存在

---

### 2.2 GET /api/v1/biz-conv/:convId

取得商業對話資訊（加密 blob）。

**權限:** 成員

**Response (200):**
```json
{
  "ok": true,
  "conversation_id": "...",
  "owner_account_digest": "...",
  "encrypted_meta_blob": "...",
  "encrypted_policy_blob": "...",
  "key_epoch": 0,
  "status": "active",
  "created_at": 1710000000
}
```

---

### 2.3 PUT /api/v1/biz-conv/:convId/meta

更新加密 meta blob（群組名稱、描述等）。

**權限:** 群主

**Request:**
```json
{
  "encrypted_meta_blob": "{ v, iv_b64, ct_b64 }"
}
```

**Response (200):**
```json
{ "ok": true }
```

---

### 2.4 PUT /api/v1/biz-conv/:convId/policy

更新加密 Policy blob。

**權限:** 群主

**Request:**
```json
{
  "encrypted_policy_blob": "{ v, iv_b64, ct_b64 }"
}
```

**處理邏輯:**
1. 驗證群主身份
2. 更新 `encrypted_policy_blob`
3. 建立 `policy_changed` tombstone
4. 廣播 WS 事件 `biz-conv-policy-updated`

**Response (200):**
```json
{ "ok": true }
```

---

### 2.5 POST /api/v1/biz-conv/:convId/dissolve

解散商業對話（硬刪除所有資料）。

**權限:** 群主

**處理邏輯:**
1. 驗證群主身份
2. 廣播 WS 事件 `biz-conv-dissolved`（在刪除前，確保成員收到通知）
3. 硬刪除（按順序，遵守 FK 約束）：
   - `messages_secure WHERE conversation_id = ?`
   - `attachments WHERE conversation_id = ?`
   - `business_conversation_tombstones WHERE conversation_id = ?`
   - `business_conversation_members WHERE conversation_id = ?`
   - `conversation_acl WHERE conversation_id = ?`
   - `business_conversations WHERE conversation_id = ?`
4. 清理相關的 `message_key_vault` 記錄

**Response (200):**
```json
{ "ok": true, "deleted": true }
```

---

## 三、成員管理

### 3.1 POST /api/v1/biz-conv/:convId/invite

邀請新成員加入。

**權限:** 群主，或 active 成員（依 policy — 伺服器端無法驗證 policy 內容，僅檢查是否為 active 成員）

**Request:**
```json
{
  "invitee_account_digest": "..."
}
```

**處理邏輯:**
1. 驗證操作者為 active 成員
2. 檢查被邀請者是否為有效帳號
3. 檢查被邀請者是否已是成員（若 status = left/removed，更新為 active）
4. 建立 `business_conversation_members` 記錄
5. 建立 `conversation_acl` 記錄
6. 建立 `member_joined` tombstone
7. 廣播 WS 事件 `biz-conv-member-changed`

**Response (200):**
```json
{
  "ok": true,
  "tombstone_id": "..."
}
```

**Error Responses:**
- 400: invitee_account_digest 缺失
- 403: 操作者非 active 成員
- 409: 被邀請者已是 active 成員

---

### 3.2 POST /api/v1/biz-conv/:convId/remove

踢除成員。

**權限:** 群主

**Request:**
```json
{
  "target_account_digest": "..."
}
```

**處理邏輯:**
1. 驗證群主身份
2. 驗證 target 是 active 成員且不是 owner 自己
3. 更新 `business_conversation_members.status = 'removed'`
4. 刪除 `conversation_acl` 記錄
5. 建立 `member_removed` tombstone
6. 廣播 WS 事件 `biz-conv-member-changed`
7. 通知被踢者（WS 特定推送）

**Response (200):**
```json
{
  "ok": true,
  "tombstone_id": "...",
  "requires_key_rotation": true
}
```

---

### 3.3 POST /api/v1/biz-conv/:convId/leave

成員自行離開。

**權限:** active 成員（不能是 owner — owner 必須先轉移身份）

**Request:**
```json
{}
```

**處理邏輯:**
1. 驗證操作者為 active 成員
2. 驗證操作者不是 owner（owner 不能離開）
3. 更新 `business_conversation_members.status = 'left'`
4. 刪除 `conversation_acl` 記錄
5. 建立 `member_left` tombstone
6. 廣播 WS 事件 `biz-conv-member-changed`

**Response (200):**
```json
{
  "ok": true,
  "tombstone_id": "...",
  "requires_key_rotation": true
}
```

**Error Responses:**
- 403: 操作者是 owner（必須先 transfer）

---

### 3.4 POST /api/v1/biz-conv/:convId/transfer

轉移群主身份。

**權限:** 群主

**Request:**
```json
{
  "new_owner_account_digest": "..."
}
```

**處理邏輯:**
1. 驗證群主身份
2. 驗證 new_owner 是 active 成員
3. 更新 `business_conversations.owner_account_digest`
4. 建立 `ownership_transferred` tombstone
5. 廣播 WS 事件 `biz-conv-ownership-transferred`

**Response (200):**
```json
{
  "ok": true,
  "tombstone_id": "..."
}
```

---

### 3.5 GET /api/v1/biz-conv/:convId/members

取得成員列表。

**權限:** active 成員

**Response (200):**
```json
{
  "ok": true,
  "members": [
    {
      "account_digest": "...",
      "encrypted_role_blob": "...",
      "status": "active",
      "confirmed_epoch": 0,
      "created_at": 1710000000
    }
  ]
}
```

---

## 四、Key Epoch 管理

### 4.1 POST /api/v1/biz-conv/:convId/epoch

遞增 key epoch（觸發 key rotation）。

**權限:** 群主

**處理邏輯:**
1. 驗證群主身份
2. `key_epoch = key_epoch + 1`
3. 廣播 WS 事件 `biz-conv-key-rotated`

**Response (200):**
```json
{
  "ok": true,
  "new_epoch": 1
}
```

### 4.2 POST /api/v1/biz-conv/:convId/epoch/confirm

成員確認已收到新 epoch 的 KDM。

**權限:** active 成員

**Request:**
```json
{
  "epoch": 1
}
```

**處理邏輯:**
1. 驗證操作者為 active 成員
2. 更新 `confirmed_epoch = MAX(confirmed_epoch, epoch)`

**Response (200):**
```json
{ "ok": true }
```

### 4.3 GET /api/v1/biz-conv/:convId/epoch

查詢當前 epoch 狀態。

**權限:** active 成員

**Response (200):**
```json
{
  "ok": true,
  "key_epoch": 1,
  "pending_members": [
    { "account_digest": "...", "confirmed_epoch": 0 }
  ]
}
```

---

## 五、Tombstone 端點

### 5.1 POST /api/v1/biz-conv/:convId/tombstone

新增 tombstone。

**權限:** active 成員

**Request:**
```json
{
  "tombstone_type": "friend_added",
  "encrypted_payload_blob": "{ v, iv_b64, ct_b64 }"
}
```

**Response (200):**
```json
{
  "ok": true,
  "tombstone_id": "...",
  "created_at": 1710000000
}
```

### 5.2 GET /api/v1/biz-conv/:convId/tombstones

取得 tombstone 列表（分頁）。

**權限:** active 成員

**Query Params:**
- `since` (optional): 時間戳，取此時間之後的記錄
- `limit` (optional): 筆數限制（預設 50，最大 200）

**Response (200):**
```json
{
  "ok": true,
  "tombstones": [
    {
      "id": "...",
      "tombstone_type": "member_joined",
      "encrypted_payload_blob": "...",
      "actor_account_digest": "...",
      "key_epoch": 0,
      "created_at": 1710000000
    }
  ],
  "has_more": false
}
```

---

## 六、列表端點

### 6.1 GET /api/v1/biz-conv/list

列出使用者參與的所有商業對話。

**權限:** 已登入用戶

**Response (200):**
```json
{
  "ok": true,
  "conversations": [
    {
      "conversation_id": "...",
      "owner_account_digest": "...",
      "encrypted_meta_blob": "...",
      "key_epoch": 0,
      "status": "active",
      "my_status": "active",
      "my_confirmed_epoch": 0,
      "created_at": 1710000000
    }
  ]
}
```

---

## 七、Worker 路由結構

```javascript
// data-worker/src/worker.js 中新增

async function handleBizConvRoutes(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // POST /d1/biz-conv/create
  // GET  /d1/biz-conv/get?conversationId=...
  // PUT  /d1/biz-conv/meta
  // PUT  /d1/biz-conv/policy
  // POST /d1/biz-conv/dissolve
  // POST /d1/biz-conv/invite
  // POST /d1/biz-conv/remove
  // POST /d1/biz-conv/leave
  // POST /d1/biz-conv/transfer
  // GET  /d1/biz-conv/members?conversationId=...
  // POST /d1/biz-conv/epoch
  // POST /d1/biz-conv/epoch/confirm
  // GET  /d1/biz-conv/epoch?conversationId=...
  // POST /d1/biz-conv/tombstone
  // GET  /d1/biz-conv/tombstones?conversationId=...
  // GET  /d1/biz-conv/list

  // ... implementation ...
}
```

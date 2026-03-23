# 商業對話 — WebSocket 事件規格

> 版本：v1.0-draft | 日期：2026-03-16

---

## 一、事件傳遞架構

```
發送者客戶端
  │
  ├── HTTP API (管理操作)
  │     └── Worker 處理 → 寫入 DB → 廣播 WS 事件
  │
  └── WebSocket (即時訊息)
        └── AccountWebSocket DO → 路由至對話成員 → 各成員 WS 連線
```

### 1.1 廣播機制

商業對話的 WS 廣播需要查詢成員列表：

```javascript
async function broadcastBizConvEvent(env, conversationId, event, excludeDigest = null) {
  // 1. 查詢所有 active 成員
  const members = await env.DB.prepare(
    `SELECT account_digest FROM business_conversation_members
     WHERE conversation_id = ?1 AND status = 'active'`
  ).bind(conversationId).all();

  // 2. 對每位成員推送 WS 事件（排除 excludeDigest）
  for (const member of members.results || []) {
    if (member.account_digest === excludeDigest) continue;
    await pushToAccountWS(env, member.account_digest, event);
  }
}
```

---

## 二、事件類型定義

### 2.1 biz-conv-message — 群組訊息

```json
{
  "type": "biz-conv-message",
  "conversation_id": "SHA-256-hash",
  "message_id": "uuid",
  "sender_account_digest": "hex",
  "sender_device_id": "uuid",
  "epoch": 0,
  "counter": 42,
  "iv_b64": "base64url(12 bytes)",
  "ciphertext_b64": "base64url(encrypted)",
  "ts": 1710000000000
}
```

**觸發時機:** 成員發送群組訊息
**接收者:** 所有 active 成員（排除發送者）
**客戶端處理:** 用 Sender Key 解密 → 顯示在對話中

---

### 2.2 biz-conv-member-changed — 成員變動

```json
{
  "type": "biz-conv-member-changed",
  "conversation_id": "SHA-256-hash",
  "action": "joined",
  "account_digest": "hex",
  "actor_account_digest": "hex",
  "tombstone_id": "uuid",
  "ts": 1710000000000
}
```

**action 值:**
- `joined` — 新成員加入
- `left` — 成員自行離開
- `removed` — 成員被踢除

**觸發時機:** invite / leave / remove API 呼叫後
**接收者:** 所有 active 成員
**客戶端處理:**
- `joined`: 更新本地成員列表，顯示 tombstone
- `left` / `removed`: 更新本地成員列表，顯示 tombstone，owner 觸發 key rotation

---

### 2.3 biz-conv-policy-updated — Policy 更新

```json
{
  "type": "biz-conv-policy-updated",
  "conversation_id": "SHA-256-hash",
  "tombstone_id": "uuid",
  "ts": 1710000000000
}
```

**觸發時機:** PUT /policy API 呼叫後
**接收者:** 所有 active 成員（排除 owner）
**客戶端處理:** GET /api/v1/biz-conv/:convId 重新取得加密 policy blob → 解密 → 更新本地 Policy

---

### 2.4 biz-conv-ownership-transferred — 群主轉移

```json
{
  "type": "biz-conv-ownership-transferred",
  "conversation_id": "SHA-256-hash",
  "previous_owner_account_digest": "hex",
  "new_owner_account_digest": "hex",
  "tombstone_id": "uuid",
  "ts": 1710000000000
}
```

**觸發時機:** POST /transfer API 呼叫後
**接收者:** 所有 active 成員
**客戶端處理:** 更新本地的 owner 資訊，顯示 tombstone

---

### 2.5 biz-conv-dissolved — 群組解散

```json
{
  "type": "biz-conv-dissolved",
  "conversation_id": "SHA-256-hash",
  "ts": 1710000000000
}
```

**觸發時機:** POST /dissolve API 呼叫後（在硬刪除之前發送）
**接收者:** 所有 active 成員（排除 owner）
**客戶端處理:**
1. 顯示「群組已解散」通知
2. 清除本地該對話的所有資料（messages, seeds, chain states）
3. 從對話列表中移除

---

### 2.6 biz-conv-key-rotated — 密鑰輪換

```json
{
  "type": "biz-conv-key-rotated",
  "conversation_id": "SHA-256-hash",
  "new_epoch": 1,
  "ts": 1710000000000
}
```

**觸發時機:** POST /epoch API 呼叫後
**接收者:** 所有 active 成員（排除 owner）
**客戶端處理:**
1. 檢查是否已收到對應 epoch 的 KDM（透過 DR session）
2. 如果尚未收到 KDM，等待（KDM 透過 pairwise DR session 獨立傳輸）
3. 收到 KDM 後，confirm epoch

---

### 2.7 biz-conv-removed-notification — 被踢通知（定向推送）

```json
{
  "type": "biz-conv-removed-notification",
  "conversation_id": "SHA-256-hash",
  "reason": "removed",
  "ts": 1710000000000
}
```

**觸發時機:** 成員被踢除時
**接收者:** 僅被踢者
**客戶端處理:**
1. 顯示「你已被移出群組」通知
2. 清除本地該對話的所有密鑰資料
3. 保留已解密的歷史訊息（可選）或完全清除（視 UX 決策）

---

## 三、訊息路由

### 3.1 群組訊息路由（AccountWebSocket 擴展）

```javascript
// account-ws.js 中新增群組訊息處理

case 'biz-conv-message': {
  const { conversation_id } = msg;

  // 1. 驗證發送者是否為 active 成員
  const membership = await env.DB.prepare(
    `SELECT status FROM business_conversation_members
     WHERE conversation_id = ?1 AND account_digest = ?2`
  ).bind(conversation_id, senderAccountDigest).first();

  if (!membership || membership.status !== 'active') {
    ws.send(JSON.stringify({ type: 'error', error: 'not_member' }));
    break;
  }

  // 2. 儲存密文至 messages_secure
  await env.DB.prepare(
    `INSERT INTO messages_secure (id, conversation_id, sender_account_digest,
       sender_device_id, receiver_account_digest, receiver_device_id,
       header_json, ciphertext_b64, counter, created_at)
     VALUES (?1, ?2, ?3, ?4, '', '', ?5, ?6, ?7, ?8)`
  ).bind(
    msg.message_id, conversation_id, senderAccountDigest,
    msg.sender_device_id,
    JSON.stringify({ epoch: msg.epoch, counter: msg.counter, sender_device_id: msg.sender_device_id }),
    msg.ciphertext_b64, msg.counter, Date.now()
  ).run();

  // 3. 廣播至其他 active 成員
  await broadcastBizConvEvent(env, conversation_id, {
    type: 'biz-conv-message',
    message_id: msg.message_id,
    conversation_id,
    sender_account_digest: senderAccountDigest,
    sender_device_id: msg.sender_device_id,
    epoch: msg.epoch,
    counter: msg.counter,
    iv_b64: msg.iv_b64,
    ciphertext_b64: msg.ciphertext_b64,
    ts: Date.now()
  }, senderAccountDigest);

  break;
}
```

---

## 四、客戶端 WS 整合

### 4.1 ws-integration.js 擴展

```javascript
// 新增商業對話事件處理
function handleBizConvWSEvent(event) {
  switch (event.type) {
    case 'biz-conv-message':
      return handleIncomingBizConvMessage(event);
    case 'biz-conv-member-changed':
      return handleBizConvMemberChanged(event);
    case 'biz-conv-policy-updated':
      return handleBizConvPolicyUpdated(event);
    case 'biz-conv-ownership-transferred':
      return handleBizConvOwnershipTransferred(event);
    case 'biz-conv-dissolved':
      return handleBizConvDissolved(event);
    case 'biz-conv-key-rotated':
      return handleBizConvKeyRotated(event);
    case 'biz-conv-removed-notification':
      return handleBizConvRemovedNotification(event);
  }
}
```

---

## 五、離線訊息處理

離線成員在重新上線後需要：

1. **拉取未讀群組訊息**：透過 HTTP API 取得 `messages_secure` 中的歷史記錄
2. **拉取未處理的 tombstone**：GET /tombstones?since=lastSeen
3. **檢查 key epoch**：若 `confirmed_epoch < key_epoch`，等待 KDM 或請求群主重發
4. **處理成員變動**：根據 tombstone 更新本地成員列表

```javascript
async function syncBizConvOnReconnect(conversationId) {
  // 1. 取得當前對話狀態
  const conv = await apiBizConvGet(conversationId);
  if (conv.status === 'dissolved') {
    await cleanupLocalBizConv(conversationId);
    return;
  }

  // 2. 同步 tombstones
  const lastTs = await getLastTombstoneTs(conversationId);
  const tombstones = await apiBizConvTombstones(conversationId, { since: lastTs });
  for (const ts of tombstones) {
    await processTombstone(ts);
  }

  // 3. 檢查 key epoch
  if (conv.key_epoch > localEpoch) {
    // 等待 KDM 到達（會透過 DR session 的離線訊息機制送達）
    await waitForKDM(conversationId, conv.key_epoch);
  }

  // 4. 拉取未讀訊息
  await fetchMissedBizConvMessages(conversationId);
}
```

# 商業對話 — Tombstone 規格

> 版本：v1.0-draft | 日期：2026-03-16

---

## 一、Tombstone 概念

Tombstone 是群組對話中的「系統事件標記」，穿插在訊息時間線中。
它記錄成員變動、管理操作、好友關係等重要事件。

**核心原則:**
- Tombstone **不可刪除**（除非群組解散時全部硬刪除）
- Tombstone 的顯示內容是**加密**的（用 group_meta_key）
- 伺服器僅知道 tombstone 類型和時間戳，不知道具體描述

---

## 二、Tombstone 類型

| 類型 | 觸發事件 | 顯示範例 |
|------|---------|---------|
| `member_joined` | 成員加入 | "Bob 已加入對話" |
| `member_left` | 成員離開 | "Carol 已離開對話" |
| `member_removed` | 成員被踢除 | "Eve 已被移出對話" |
| `ownership_transferred` | 群主轉移 | "Alice 已將管理權轉移給 Bob" |
| `policy_changed` | Policy 修改 | "Alice 已更新對話設定" |
| `friend_added` | 群內互加好友 | "Alice 已經與 Bob 透過群組成為好友" |
| `conversation_dissolved` | 群組解散 | "Alice 已解散此對話"（僅在解散前短暫顯示） |

---

## 三、Tombstone 加密 Payload 結構

### 3.1 通用結構

```javascript
const tombstonePayload = {
  v: 1,                          // Payload 版本
  type: 'member_joined',         // 與 tombstone_type 一致
  actor: 'Alice',                // 操作者名稱（從加密的 member role blob 取得）
  actor_digest: '3a4f...',       // 操作者 account_digest（用於 UI 渲染 identicon）
  ts: 1710000000000              // 精確時間戳

  // 以下欄位依類型而異...
};
```

### 3.2 各類型 Payload

#### member_joined

```javascript
{
  v: 1,
  type: 'member_joined',
  actor: 'Bob',              // 加入者
  actor_digest: '3a4f...',
  inviter: 'Alice',          // 邀請者（可選）
  inviter_digest: '8b2c...',
  message: 'Bob 已加入對話',
  ts: 1710000000000
}
```

#### member_left

```javascript
{
  v: 1,
  type: 'member_left',
  actor: 'Carol',
  actor_digest: '5d7e...',
  message: 'Carol 已離開對話',
  ts: 1710000000000
}
```

#### member_removed

```javascript
{
  v: 1,
  type: 'member_removed',
  actor: 'Alice',            // 執行踢除的人（owner）
  actor_digest: '8b2c...',
  target: 'Eve',             // 被踢者
  target_digest: '9f1a...',
  message: 'Eve 已被移出對話',
  ts: 1710000000000
}
```

#### ownership_transferred

```javascript
{
  v: 1,
  type: 'ownership_transferred',
  actor: 'Alice',            // 原 owner
  actor_digest: '8b2c...',
  target: 'Bob',             // 新 owner
  target_digest: '3a4f...',
  message: 'Alice 已將管理權轉移給 Bob',
  ts: 1710000000000
}
```

#### policy_changed

```javascript
{
  v: 1,
  type: 'policy_changed',
  actor: 'Alice',
  actor_digest: '8b2c...',
  changes: [
    { field: 'allow_member_invite', from: false, to: true }
  ],
  message: 'Alice 已更新對話設定',
  ts: 1710000000000
}
```

#### friend_added

```javascript
{
  v: 1,
  type: 'friend_added',
  actor: 'Alice',
  actor_digest: '8b2c...',
  target: 'Bob',
  target_digest: '3a4f...',
  message: 'Alice 已經與 Bob 透過群組成為好友',
  ts: 1710000000000
}
```

#### conversation_dissolved

```javascript
{
  v: 1,
  type: 'conversation_dissolved',
  actor: 'Alice',
  actor_digest: '8b2c...',
  message: 'Alice 已解散此對話',
  ts: 1710000000000
}
```

---

## 四、Tombstone 加密

### 4.1 加密

```javascript
async function encryptTombstone(groupMetaKey, epoch, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const aad = new TextEncoder().encode(`sentry/biz-conv/tombstone/v1/${epoch}`);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    groupMetaKey,
    plaintext
  );
  return {
    v: 1,
    epoch,
    iv_b64: bytesToB64Url(iv),
    ct_b64: bytesToB64Url(new Uint8Array(ct))
  };
}
```

### 4.2 解密

```javascript
async function decryptTombstone(groupMetaKey, encryptedBlob) {
  const { epoch, iv_b64, ct_b64 } = JSON.parse(encryptedBlob);
  const iv = b64UrlToBytes(iv_b64);
  const ct = b64UrlToBytes(ct_b64);
  const aad = new TextEncoder().encode(`sentry/biz-conv/tombstone/v1/${epoch}`);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    groupMetaKey,
    ct
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
```

> 注意：Tombstone 解密需要對應 epoch 的 group_meta_key。
> 客戶端必須保留歷史 epoch 的 seed 才能解密較舊的 tombstone。

---

## 五、Tombstone 在時間線中的渲染

### 5.1 時間線整合

Tombstone 與訊息混合排序在同一時間線中，按 `created_at` 排序：

```
┌─────────────────────────────────────────┐
│  [10:00] Alice: 大家好！                  │
│  [10:01] Bob: 你好！                      │
│                                           │
│  ─── Carol 已加入對話 ───                  │  ← tombstone
│                                           │
│  [10:05] Carol: 謝謝邀請                   │
│  [10:10] Alice: 歡迎！                     │
│                                           │
│  ─── Alice 已經與 Bob 透過群組成為好友 ───  │  ← tombstone
│                                           │
│  [10:15] Bob: 收到                         │
└─────────────────────────────────────────┘
```

### 5.2 UI 渲染規則

```javascript
function renderTombstone(tombstone) {
  // Tombstone 以居中、淺灰背景的系統訊息樣式渲染
  return {
    type: 'system',
    text: tombstone.message,
    timestamp: tombstone.ts,
    style: 'tombstone'
  };
}
```

### 5.3 semantic.js 整合

新增 tombstone 到 message type 分類：

```javascript
// USER_MESSAGE_TYPES 擴展
'biz-conv-tombstone'  // 顯示在時間線中的系統事件
```

---

## 六、Tombstone 生命週期

```
建立 Tombstone
  │
  ├── Server 建立記錄 (POST /tombstone)
  │     ├── 儲存至 business_conversation_tombstones
  │     └── 廣播 WS 事件（member-changed / policy-updated 等）
  │
  ├── 客戶端接收 WS 事件
  │     ├── 取得 tombstone_id
  │     ├── 解密 encrypted_payload_blob
  │     └── 插入本地時間線
  │
  └── 群組解散時硬刪除
        └── DELETE FROM business_conversation_tombstones WHERE conversation_id = ?
```

---

## 七、離線成員同步

離線成員重新上線時：

```javascript
async function syncTombstones(conversationId, lastSeenTs) {
  // 1. 拉取 lastSeenTs 之後的所有 tombstone
  const { tombstones } = await apiBizConvTombstones(conversationId, { since: lastSeenTs });

  // 2. 逐一解密並處理
  for (const ts of tombstones) {
    const payload = await decryptTombstone(groupMetaKey, ts.encrypted_payload_blob);

    // 3. 更新本地狀態
    switch (payload.type) {
      case 'member_joined':
        await addLocalMember(conversationId, payload);
        break;
      case 'member_left':
      case 'member_removed':
        await removeLocalMember(conversationId, payload);
        break;
      case 'ownership_transferred':
        await updateLocalOwner(conversationId, payload);
        break;
      case 'policy_changed':
        // Policy 會在 GET /biz-conv/:id 時重新取得
        break;
      case 'friend_added':
        // 僅顯示，不需額外處理
        break;
    }

    // 4. 插入本地時間線
    await insertTombstoneInTimeline(conversationId, ts.id, payload);
  }
}
```

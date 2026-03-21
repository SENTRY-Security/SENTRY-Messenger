# 商業對話 — 資料庫 Schema 規格

> 版本：v1.0-draft | 日期：2026-03-16

---

## 一、Migration 策略

### 1.1 新增 Migration 檔案

檔名：`data-worker/migrations/0013_add_business_conversations.sql`

此 migration 會：
1. DROP 舊的 groups、group_members、group_invites 表
2. CREATE 新的 business_conversations、business_conversation_members、business_conversation_tombstones 表

### 1.2 舊表移除

```sql
-- 移除舊群組表（功能從未上線，無資料需要遷移）
DROP TABLE IF EXISTS group_invites;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
```

---

## 二、新表定義

### 2.1 business_conversations

主表，儲存商業對話的核心資訊。

```sql
CREATE TABLE IF NOT EXISTS business_conversations (
  -- conversation_id: 由 group_seed 透過 HKDF + SHA-256 衍生
  -- 伺服器無法反推 group_seed
  conversation_id TEXT PRIMARY KEY,

  -- 群主身份：唯一可執行管理操作的 account
  -- 可透過 /transfer API 轉移
  owner_account_digest TEXT NOT NULL,

  -- 加密的群組 metadata（名稱、描述、avatar 等）
  -- 用 group_meta_key 加密，伺服器無法解讀
  -- 格式: { v: 1, iv_b64: "...", ct_b64: "..." }
  encrypted_meta_blob TEXT,

  -- 加密的 Policy（成員邀請權限、好友權限等）
  -- 用 group_meta_key 加密，伺服器無法解讀
  -- 格式: { v: 1, iv_b64: "...", ct_b64: "..." }
  encrypted_policy_blob TEXT,

  -- 當前密鑰 epoch（單調遞增，每次 key rotation +1）
  -- 伺服器僅知道數字，不知道對應的 key
  key_epoch INTEGER NOT NULL DEFAULT 0,

  -- 狀態
  -- active: 正常運作
  -- dissolved: 已解散（等待清理或已清理）
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'dissolved')),

  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 查詢某帳號擁有的所有商業對話
CREATE INDEX IF NOT EXISTS idx_biz_conv_owner
  ON business_conversations(owner_account_digest);

-- 按狀態過濾
CREATE INDEX IF NOT EXISTS idx_biz_conv_status
  ON business_conversations(status);
```

### 2.2 business_conversation_members

成員表，追蹤每個商業對話的參與者。

```sql
CREATE TABLE IF NOT EXISTS business_conversation_members (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,

  -- 加密的角色資訊
  -- 用 group_meta_key 加密，伺服器不知道成員的業務角色
  -- 明文結構: { role: "owner"|"admin"|"member", nickname: "...", ... }
  encrypted_role_blob TEXT,

  -- 成員狀態（伺服器可見，用於 ACL 路由決策）
  -- active: 正常成員
  -- left: 自行離開
  -- removed: 被群主踢除
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'left', 'removed')),

  -- 該成員已確認的最新 key epoch
  -- 若 < business_conversations.key_epoch，表示需要補發 KDM
  confirmed_epoch INTEGER NOT NULL DEFAULT 0,

  -- 邀請者（可選）
  inviter_account_digest TEXT,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),

  PRIMARY KEY (conversation_id, account_digest),

  FOREIGN KEY (conversation_id)
    REFERENCES business_conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (account_digest)
    REFERENCES accounts(account_digest) ON DELETE CASCADE
);

-- 查詢某帳號參與的所有商業對話
CREATE INDEX IF NOT EXISTS idx_biz_conv_members_account
  ON business_conversation_members(account_digest);

-- 按狀態過濾成員（ACL 查詢用）
CREATE INDEX IF NOT EXISTS idx_biz_conv_members_status
  ON business_conversation_members(conversation_id, status);

-- 查詢需要補發 KDM 的成員
CREATE INDEX IF NOT EXISTS idx_biz_conv_members_epoch
  ON business_conversation_members(conversation_id, confirmed_epoch);
```

### 2.3 business_conversation_tombstones

Tombstone 表，記錄群組內的重要事件（不可刪除，直到群組解散時硬刪除）。

```sql
CREATE TABLE IF NOT EXISTS business_conversation_tombstones (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,

  -- Tombstone 類型（伺服器可見，用於查詢/篩選）
  -- 不洩漏具體內容（內容在加密 blob 中）
  tombstone_type TEXT NOT NULL
    CHECK(tombstone_type IN (
      'member_joined',
      'member_left',
      'member_removed',
      'ownership_transferred',
      'policy_changed',
      'friend_added',
      'conversation_dissolved'
    )),

  -- 加密的事件描述
  -- 用 group_meta_key 加密，內含人類可讀文字
  -- 明文結構: { v, type, actor, target, message, ts }
  encrypted_payload_blob TEXT NOT NULL,

  -- 操作者 account_digest（用於關聯查詢）
  actor_account_digest TEXT,

  -- 事件發生時的 key epoch（用於選擇解密 key）
  key_epoch INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),

  FOREIGN KEY (conversation_id)
    REFERENCES business_conversations(conversation_id) ON DELETE CASCADE
);

-- 按時間順序查詢某對話的 tombstone
CREATE INDEX IF NOT EXISTS idx_biz_conv_tombstones_conv
  ON business_conversation_tombstones(conversation_id, created_at DESC);

-- 按類型查詢
CREATE INDEX IF NOT EXISTS idx_biz_conv_tombstones_type
  ON business_conversation_tombstones(conversation_id, tombstone_type);
```

---

## 三、conversation_acl 複用

現有 `conversation_acl` 表不需修改，商業對話的成員會被加入此表：

```sql
-- 既有結構（不修改）
-- conversation_acl (conversation_id, account_digest, device_id, role, created_at, updated_at)
--   PRIMARY KEY (conversation_id, account_digest, device_id)

-- 商業對話加入成員時：
INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
VALUES (?1, ?2, ?3, 'member');

-- 商業對話移除成員時：
DELETE FROM conversation_acl
WHERE conversation_id = ?1 AND account_digest = ?2;
```

---

## 四、messages_secure 複用

現有 `messages_secure` 表可直接用於商業對話訊息：

```sql
-- 既有結構（不修改）
-- 商業對話訊息的 conversation_id 就是 business_conversations.conversation_id
-- sender_account_digest / sender_device_id 用於識別發送者
-- header_json 中會包含 epoch 和 sender key counter
-- ciphertext_b64 為 Sender Key 加密的密文
```

差異：
- 1-to-1 訊息：`header_json` 中有 DR header（ek_pub, pn, n）
- 商業對話訊息：`header_json` 中有 Sender Key header（epoch, counter）

可以透過 `header_json` 中是否有 `epoch` 欄位來區分。

---

## 五、完整 Migration SQL

```sql
-- Migration: 0013_add_business_conversations.sql
-- 移除舊群組表，建立商業對話表

-- Step 1: 移除舊表（cascade 順序）
DROP TABLE IF EXISTS group_invites;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;

-- Step 2: 建立商業對話主表
CREATE TABLE IF NOT EXISTS business_conversations (
  conversation_id TEXT PRIMARY KEY,
  owner_account_digest TEXT NOT NULL,
  encrypted_meta_blob TEXT,
  encrypted_policy_blob TEXT,
  key_epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'dissolved')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_biz_conv_owner
  ON business_conversations(owner_account_digest);
CREATE INDEX IF NOT EXISTS idx_biz_conv_status
  ON business_conversations(status);

-- Step 3: 建立成員表
CREATE TABLE IF NOT EXISTS business_conversation_members (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  encrypted_role_blob TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'left', 'removed')),
  confirmed_epoch INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_biz_conv_members_epoch
  ON business_conversation_members(conversation_id, confirmed_epoch);

-- Step 4: 建立 Tombstone 表
CREATE TABLE IF NOT EXISTS business_conversation_tombstones (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tombstone_type TEXT NOT NULL
    CHECK(tombstone_type IN (
      'member_joined',
      'member_left',
      'member_removed',
      'ownership_transferred',
      'policy_changed',
      'friend_added',
      'conversation_dissolved'
    )),
  encrypted_payload_blob TEXT NOT NULL,
  actor_account_digest TEXT,
  key_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (conversation_id)
    REFERENCES business_conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_biz_conv_tombstones_conv
  ON business_conversation_tombstones(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biz_conv_tombstones_type
  ON business_conversation_tombstones(conversation_id, tombstone_type);

-- Step 5: updated_at trigger for business_conversations
CREATE TRIGGER IF NOT EXISTS trg_biz_conv_updated
  AFTER UPDATE ON business_conversations
  FOR EACH ROW
  BEGIN
    UPDATE business_conversations
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id;
  END;

-- Step 6: updated_at trigger for business_conversation_members
CREATE TRIGGER IF NOT EXISTS trg_biz_conv_members_updated
  AFTER UPDATE ON business_conversation_members
  FOR EACH ROW
  BEGIN
    UPDATE business_conversation_members
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id
       AND account_digest = OLD.account_digest;
  END;
```

---

## 六、資料分類（安全等級）

| 欄位 | 安全等級 | 說明 |
|------|---------|------|
| conversation_id | C1 (Internal) | SHA-256 hash，無法反推 |
| owner_account_digest | C1 (Internal) | 帳號 hash，已是不可逆 |
| encrypted_meta_blob | C2 (Confidential) | 加密 blob，需 group_meta_key |
| encrypted_policy_blob | C2 (Confidential) | 加密 blob，需 group_meta_key |
| key_epoch | C0 (Public) | 僅為遞增數字 |
| status | C0 (Public) | 僅 active/dissolved |
| encrypted_role_blob | C2 (Confidential) | 加密 blob，需 group_meta_key |
| member status | C1 (Internal) | active/left/removed |
| encrypted_payload_blob | C2 (Confidential) | 加密 tombstone 內容 |
| tombstone_type | C1 (Internal) | 事件類型（無具體內容） |

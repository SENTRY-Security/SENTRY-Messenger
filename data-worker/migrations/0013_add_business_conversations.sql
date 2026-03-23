-- Migration: 0013_add_business_conversations
-- Remove legacy group tables (never launched) and create Business Conversation tables.

-- Step 1: Remove legacy group tables (no data to migrate — feature was never enabled)
DROP TABLE IF EXISTS group_invites;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;

-- Step 2: Business Conversations (replaces groups)
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

-- Step 3: Business Conversation Members (replaces group_members)
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

-- Step 4: Business Conversation Tombstones
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

-- Step 5: Auto-update triggers
CREATE TRIGGER IF NOT EXISTS trg_biz_conv_updated
  AFTER UPDATE ON business_conversations
  FOR EACH ROW
  BEGIN
    UPDATE business_conversations
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_biz_conv_members_updated
  AFTER UPDATE ON business_conversation_members
  FOR EACH ROW
  BEGIN
    UPDATE business_conversation_members
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id
       AND account_digest = OLD.account_digest;
  END;

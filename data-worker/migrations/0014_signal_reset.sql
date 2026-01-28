-- Signal-style messaging reset: per-device X3DH/DR schema
-- This migration intentionally drops legacy messaging/prekey tables.

DROP TABLE IF EXISTS device_opks;
DROP TABLE IF EXISTS device_signed_prekeys;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS messages_secure;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS media_objects;
DROP TABLE IF EXISTS conversation_acl;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS prekey_opk;
DROP TABLE IF EXISTS prekey_users;

CREATE TABLE IF NOT EXISTS devices (
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (account_digest, device_id)
);

CREATE TABLE IF NOT EXISTS device_signed_prekeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  spk_id INTEGER NOT NULL,
  spk_pub TEXT NOT NULL,
  spk_sig TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (account_digest, device_id, spk_id),
  FOREIGN KEY (account_digest, device_id) REFERENCES devices(account_digest, device_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_opks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  opk_id INTEGER NOT NULL,
  opk_pub TEXT NOT NULL,
  issued_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  consumed_at INTEGER,
  UNIQUE (account_digest, device_id, opk_id),
  FOREIGN KEY (account_digest, device_id) REFERENCES devices(account_digest, device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_opks_fetch ON device_opks (account_digest, device_id, consumed_at, opk_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  token_b64 TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS conversation_acl (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  device_id TEXT,
  role TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (conversation_id, account_digest, device_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_acl_account_device ON conversation_acl (account_digest, device_id);

CREATE TRIGGER IF NOT EXISTS trg_conversation_acl_updated
  AFTER UPDATE ON conversation_acl
  FOR EACH ROW
  BEGIN
    UPDATE conversation_acl
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id
       AND account_digest = OLD.account_digest
       AND (
         (device_id IS NULL AND OLD.device_id IS NULL) OR
         device_id = OLD.device_id
       );
  END;

CREATE TABLE IF NOT EXISTS messages_secure (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_account_digest TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  receiver_account_digest TEXT NOT NULL,
  receiver_device_id TEXT,
  header_json TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  counter INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_secure_conv_ts ON messages_secure (conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_secure_sender_counter ON messages_secure (sender_account_digest, sender_device_id, counter);

CREATE TABLE IF NOT EXISTS attachments (
  object_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_account_digest TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  envelope_json TEXT,
  size_bytes INTEGER,
  content_type TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments (message_id);

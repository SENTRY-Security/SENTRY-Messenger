-- tables
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text','media')),
  aead TEXT NOT NULL,
  header_json TEXT,
  obj_key TEXT,
  size_bytes INTEGER,
  ts INTEGER NOT NULL,
  FOREIGN KEY (conv_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_objects (
  obj_key TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_acl (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  fingerprint TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (conversation_id, account_digest)
);

-- indexes (must be separate in SQLite/D1)
CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages (conv_id, ts);
CREATE INDEX IF NOT EXISTS idx_media_conv ON media_objects (conv_id);
CREATE INDEX IF NOT EXISTS idx_conversation_acl_account ON conversation_acl (account_digest);

-- triggers
CREATE TRIGGER IF NOT EXISTS trg_conversation_acl_updated
  AFTER UPDATE ON conversation_acl
  FOR EACH ROW
  BEGIN
    UPDATE conversation_acl
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id
       AND account_digest = OLD.account_digest;
  END;

-- Restore deletion_cursors and legacy prekey tables required by worker.js logic

-- 24. Deletion Cursors (Server-side clear history)
CREATE TABLE IF NOT EXISTS deletion_cursors (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  min_counter INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (conversation_id, account_digest)
);

-- 25. Legacy Prekey Tables (Required by worker checks)
CREATE TABLE IF NOT EXISTS prekey_users (
  account_digest TEXT PRIMARY KEY,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS prekey_opk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT,
  key_id INTEGER,
  public_key TEXT
);

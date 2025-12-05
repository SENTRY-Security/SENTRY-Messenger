-- Subscription/Topup tables (digest only, no UID)

CREATE TABLE IF NOT EXISTS subscriptions (
  digest TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS tokens (
  token_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  extend_days INTEGER NOT NULL,
  nonce TEXT,
  key_id TEXT NOT NULL,
  signature_b64 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('issued','used','invalid')),
  used_at INTEGER,
  used_by_digest TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (digest) REFERENCES subscriptions(digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tokens_digest ON tokens(digest);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);

CREATE TABLE IF NOT EXISTS extend_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  extend_days INTEGER NOT NULL,
  expires_at_after INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (token_id) REFERENCES tokens(token_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_extend_logs_digest ON extend_logs(digest);
CREATE INDEX IF NOT EXISTS idx_extend_logs_token ON extend_logs(token_id);

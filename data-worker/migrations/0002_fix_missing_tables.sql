-- Fix missing tables from 0001 consolidation (required by worker.js)

-- 18. Contact Secret Backups
CREATE TABLE IF NOT EXISTS contact_secret_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  version INTEGER,
  payload_json TEXT, -- { payload, meta }
  snapshot_version INTEGER,
  entries INTEGER,
  checksum TEXT,
  bytes INTEGER,
  device_label TEXT,
  device_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_secret_backups_account ON contact_secret_backups(account_digest, updated_at DESC);

-- 19. OPAQUE Records
CREATE TABLE IF NOT EXISTS opaque_records (
  account_digest TEXT PRIMARY KEY,
  record_b64 TEXT NOT NULL,
  client_identity TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 20. Subscriptions (Account Expiry/Tokens)
CREATE TABLE IF NOT EXISTS subscriptions (
  digest TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 21. Tokens (Access/Renewal)
CREATE TABLE IF NOT EXISTS tokens (
  token_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  issued_at INTEGER,
  extend_days INTEGER,
  nonce TEXT,
  key_id TEXT,
  signature_b64 TEXT,
  status TEXT,
  used_at INTEGER,
  used_by_digest TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 22. Extend Logs
CREATE TABLE IF NOT EXISTS extend_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT,
  digest TEXT,
  extend_days INTEGER,
  expires_at_after INTEGER,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 23. Media Objects (Legacy/Cleanup Tracker)
CREATE TABLE IF NOT EXISTS media_objects (
  obj_key TEXT PRIMARY KEY,
  conv_id TEXT,
  sender_id TEXT,
  size_bytes INTEGER,
  content_type TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_media_objects_conv ON media_objects(conv_id);

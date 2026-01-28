-- Contact secret encrypted backups table

CREATE TABLE IF NOT EXISTS contact_secret_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  snapshot_version INTEGER,
  entries INTEGER,
  checksum TEXT,
  bytes INTEGER,
  updated_at INTEGER NOT NULL,
  device_label TEXT,
  device_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_secret_backups_account_version
  ON contact_secret_backups (account_digest, version);

CREATE INDEX IF NOT EXISTS idx_contact_secret_backups_account_updated
  ON contact_secret_backups (account_digest, updated_at DESC);

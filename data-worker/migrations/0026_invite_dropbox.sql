-- Invite dropbox for offline contact-init payloads
CREATE TABLE IF NOT EXISTS invite_dropbox (
  invite_id TEXT PRIMARY KEY,
  owner_account_digest TEXT NOT NULL,
  owner_device_id TEXT NOT NULL,
  owner_public_key_b64 TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  delivered_by_account_digest TEXT,
  delivered_by_device_id TEXT,
  delivered_at INTEGER,
  consumed_at INTEGER,
  ciphertext_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invite_dropbox_expires ON invite_dropbox(expires_at);
CREATE INDEX IF NOT EXISTS idx_invite_dropbox_status ON invite_dropbox(status);
CREATE INDEX IF NOT EXISTS idx_invite_dropbox_owner ON invite_dropbox(owner_account_digest);

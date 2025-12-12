-- Rebuild friend_invites for Signal-style invites (no secret storage)
DROP TABLE IF EXISTS friend_invites;
CREATE TABLE IF NOT EXISTS friend_invites (
  invite_id TEXT PRIMARY KEY,
  owner_account_digest TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  invite_version INTEGER NOT NULL DEFAULT 2,
  owner_device_id TEXT,
  prekey_bundle TEXT,
  guest_account_digest TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_friend_invites_owner ON friend_invites(owner_account_digest);
CREATE INDEX IF NOT EXISTS idx_friend_invites_used ON friend_invites(used_at);
CREATE INDEX IF NOT EXISTS idx_friend_invites_expires ON friend_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_friend_invites_guest ON friend_invites(guest_account_digest);

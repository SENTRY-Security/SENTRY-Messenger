-- Rebuild friend_invites without prekey_bundle / guest_account_digest (no plaintext storage)
CREATE TABLE IF NOT EXISTS friend_invites_v3 (
  invite_id TEXT PRIMARY KEY,
  owner_account_digest TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  invite_version INTEGER NOT NULL DEFAULT 2,
  owner_device_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

INSERT INTO friend_invites_v3 (
  invite_id, owner_account_digest, token_hash, expires_at,
  used_at, invite_version, owner_device_id, created_at
)
SELECT
  invite_id,
  owner_account_digest,
  token_hash,
  expires_at,
  used_at,
  COALESCE(invite_version, 2),
  owner_device_id,
  COALESCE(created_at, strftime('%s','now'))
FROM friend_invites;

DROP TABLE friend_invites;
ALTER TABLE friend_invites_v3 RENAME TO friend_invites;

CREATE INDEX IF NOT EXISTS idx_friend_invites_owner ON friend_invites(owner_account_digest);
CREATE INDEX IF NOT EXISTS idx_friend_invites_used ON friend_invites(used_at);
CREATE INDEX IF NOT EXISTS idx_friend_invites_expires ON friend_invites(expires_at);

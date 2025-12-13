-- Bind invite to the exact prekey bundle used for QR (opk lock)
-- Adds columns to store owner bundle fields.
CREATE TABLE IF NOT EXISTS friend_invites_v4 (
  invite_id TEXT PRIMARY KEY,
  owner_account_digest TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  invite_version INTEGER NOT NULL DEFAULT 2,
  owner_device_id TEXT,
  prekey_ik_pub TEXT,
  prekey_spk_pub TEXT,
  prekey_spk_sig TEXT,
  prekey_opk_id INTEGER,
  prekey_opk_pub TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

INSERT INTO friend_invites_v4 (
  invite_id, owner_account_digest, token_hash, expires_at,
  used_at, invite_version, owner_device_id, created_at,
  prekey_ik_pub, prekey_spk_pub, prekey_spk_sig, prekey_opk_id, prekey_opk_pub
)
SELECT
  invite_id,
  owner_account_digest,
  token_hash,
  expires_at,
  used_at,
  COALESCE(invite_version, 2),
  owner_device_id,
  COALESCE(created_at, strftime('%s','now')),
  NULL AS prekey_ik_pub,
  NULL AS prekey_spk_pub,
  NULL AS prekey_spk_sig,
  NULL AS prekey_opk_id,
  NULL AS prekey_opk_pub
FROM friend_invites;

DROP TABLE friend_invites;
ALTER TABLE friend_invites_v4 RENAME TO friend_invites;

CREATE INDEX IF NOT EXISTS idx_friend_invites_owner ON friend_invites(owner_account_digest);
CREATE INDEX IF NOT EXISTS idx_friend_invites_used ON friend_invites(used_at);
CREATE INDEX IF NOT EXISTS idx_friend_invites_expires ON friend_invites(expires_at);

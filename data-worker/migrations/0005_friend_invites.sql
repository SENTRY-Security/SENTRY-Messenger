CREATE TABLE IF NOT EXISTS friend_invites (
  invite_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  secret TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  prekey_bundle TEXT,
  channel_seed TEXT,
  owner_contact_json TEXT,
  owner_contact_ts INTEGER,
  guest_uid TEXT,
  guest_contact_json TEXT,
  guest_contact_ts INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_friend_invites_owner ON friend_invites(owner_uid);

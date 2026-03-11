-- Ephemeral chat sessions: one-time links for temporary conversations.
-- Each link allows a non-registered guest to chat with a registered owner
-- for a limited time (default 10 minutes). Max 2 active sessions per owner.

-- 1. Ephemeral invites (one-time link tokens)
CREATE TABLE IF NOT EXISTS ephemeral_invites (
  token          TEXT PRIMARY KEY,
  owner_digest   TEXT NOT NULL,
  owner_device_id TEXT NOT NULL,
  prekey_bundle_json TEXT NOT NULL,
  consumed_at    INTEGER,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (owner_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ephemeral_invites_owner ON ephemeral_invites(owner_digest);
CREATE INDEX IF NOT EXISTS idx_ephemeral_invites_expires ON ephemeral_invites(expires_at);

-- 2. Ephemeral sessions (active temporary conversations)
CREATE TABLE IF NOT EXISTS ephemeral_sessions (
  session_id       TEXT PRIMARY KEY,
  invite_token     TEXT NOT NULL,
  owner_digest     TEXT NOT NULL,
  owner_device_id  TEXT NOT NULL,
  guest_digest     TEXT NOT NULL,
  guest_device_id  TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  expires_at       INTEGER NOT NULL,
  extended_count   INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  deleted_at       INTEGER,
  FOREIGN KEY (owner_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_owner ON ephemeral_sessions(owner_digest, deleted_at);
CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_guest ON ephemeral_sessions(guest_digest);
CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_conv ON ephemeral_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_expires ON ephemeral_sessions(expires_at);

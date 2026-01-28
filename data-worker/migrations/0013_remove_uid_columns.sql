-- Remove residual UID/uid_digest columns in favor of account_digest-only storage.

-- accounts: drop uid_plain
CREATE TABLE accounts_v2 (
  account_digest TEXT PRIMARY KEY,
  account_token TEXT NOT NULL,
  uid_digest TEXT NOT NULL UNIQUE,
  last_ctr INTEGER NOT NULL DEFAULT 0,
  wrapped_mk_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

INSERT INTO accounts_v2 (account_digest, account_token, uid_digest, last_ctr, wrapped_mk_json, created_at, updated_at)
  SELECT account_digest, account_token, uid_digest, last_ctr, wrapped_mk_json, created_at, updated_at
    FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_v2 RENAME TO accounts;

-- call_sessions: drop caller_uid / callee_uid
CREATE TABLE call_sessions_v2 (
  call_id TEXT PRIMARY KEY,
  caller_account_digest TEXT,
  callee_account_digest TEXT,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  capabilities_json TEXT,
  metadata_json TEXT,
  metrics_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  connected_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  expires_at INTEGER NOT NULL,
  last_event TEXT
);

INSERT INTO call_sessions_v2 (
  call_id, caller_account_digest, callee_account_digest, status, mode,
  capabilities_json, metadata_json, metrics_json,
  created_at, updated_at, connected_at, ended_at, end_reason, expires_at, last_event
) SELECT
  call_id, caller_account_digest, callee_account_digest, status, mode,
  capabilities_json, metadata_json, metrics_json,
  created_at, updated_at, connected_at, ended_at, end_reason, expires_at, last_event
  FROM call_sessions;

DROP TABLE call_sessions;
ALTER TABLE call_sessions_v2 RENAME TO call_sessions;
CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status);
CREATE INDEX IF NOT EXISTS idx_call_sessions_expires ON call_sessions(expires_at);

-- call_events: drop from_uid / to_uid
CREATE TABLE call_events_v2 (
  event_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  from_account_digest TEXT,
  to_account_digest TEXT,
  trace_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (call_id) REFERENCES call_sessions(call_id) ON DELETE CASCADE
);

INSERT INTO call_events_v2 (
  event_id, call_id, type, payload_json, from_account_digest, to_account_digest, trace_id, created_at
) SELECT
  event_id, call_id, type, payload_json, from_account_digest, to_account_digest, trace_id, created_at
  FROM call_events;

DROP TABLE call_events;
ALTER TABLE call_events_v2 RENAME TO call_events;
CREATE INDEX IF NOT EXISTS idx_call_events_call_created ON call_events(call_id, created_at DESC);

-- groups: drop creator_uid
CREATE TABLE groups_v2 (
  group_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  creator_account_digest TEXT NOT NULL,
  name TEXT,
  avatar_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (creator_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

INSERT INTO groups_v2 (
  group_id, conversation_id, creator_account_digest, name, avatar_json, created_at, updated_at
) SELECT
  group_id, conversation_id, creator_account_digest, name, avatar_json, created_at, updated_at
  FROM groups;

DROP TABLE groups;
ALTER TABLE groups_v2 RENAME TO groups;
CREATE INDEX IF NOT EXISTS idx_groups_conversation_id ON groups(conversation_id);
CREATE INDEX IF NOT EXISTS idx_groups_creator ON groups(creator_account_digest);

-- group_members: drop uid / inviter_uid
CREATE TABLE group_members_v2 (
  group_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','left','kicked','removed')),
  inviter_account_digest TEXT,
  joined_at INTEGER,
  muted_until INTEGER,
  last_read_ts INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (group_id, account_digest),
  FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
  FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

INSERT INTO group_members_v2 (
  group_id, account_digest, role, status, inviter_account_digest,
  joined_at, muted_until, last_read_ts, created_at, updated_at
) SELECT
  group_id, account_digest, role, status, inviter_account_digest,
  joined_at, muted_until, last_read_ts, created_at, updated_at
  FROM group_members;

DROP TABLE group_members;
ALTER TABLE group_members_v2 RENAME TO group_members;
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_account ON group_members(account_digest);
CREATE INDEX IF NOT EXISTS idx_group_members_status ON group_members(group_id, status);

-- group_invites: drop issuer_uid
CREATE TABLE group_invites_v2 (
  invite_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  issuer_account_digest TEXT,
  secret TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
  FOREIGN KEY (issuer_account_digest) REFERENCES accounts(account_digest) ON DELETE SET NULL
);

INSERT INTO group_invites_v2 (
  invite_id, group_id, issuer_account_digest, secret, expires_at, used_at, created_at, updated_at
) SELECT
  invite_id, group_id, issuer_account_digest, secret, expires_at, used_at, created_at, updated_at
  FROM group_invites;

DROP TABLE group_invites;
ALTER TABLE group_invites_v2 RENAME TO group_invites;
CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_expires ON group_invites(expires_at);

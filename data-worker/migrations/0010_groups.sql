-- 群組聊天初始 schema

CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  creator_account_digest TEXT NOT NULL,
  creator_uid TEXT,
  name TEXT,
  avatar_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (creator_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_groups_conversation_id ON groups(conversation_id);
CREATE INDEX IF NOT EXISTS idx_groups_creator ON groups(creator_account_digest);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  uid TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','left','kicked','removed')),
  inviter_account_digest TEXT,
  inviter_uid TEXT,
  joined_at INTEGER,
  muted_until INTEGER,
  last_read_ts INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (group_id, account_digest),
  FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
  FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_account ON group_members(account_digest);
CREATE INDEX IF NOT EXISTS idx_group_members_status ON group_members(group_id, status);

CREATE TABLE IF NOT EXISTS group_invites (
  invite_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  issuer_account_digest TEXT,
  issuer_uid TEXT,
  secret TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
  FOREIGN KEY (issuer_account_digest) REFERENCES accounts(account_digest) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_expires ON group_invites(expires_at);

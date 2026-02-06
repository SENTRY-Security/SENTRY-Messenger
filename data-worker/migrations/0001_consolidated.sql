-- SENTRY Messenger Consolidated Schema (v1)
-- Consolidated from migrations 0001-0031

-- 1. Accounts
CREATE TABLE IF NOT EXISTS accounts (
  account_digest TEXT PRIMARY KEY,
  account_token TEXT NOT NULL,
  uid_digest TEXT NOT NULL UNIQUE,
  uid_plain TEXT,
  last_ctr INTEGER NOT NULL DEFAULT 0,
  wrapped_mk_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 2. Device Backup (encrypted private keys)
CREATE TABLE IF NOT EXISTS device_backup (
  account_digest   TEXT PRIMARY KEY,
  wrapped_dev_json TEXT NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_device_backup_updated
  AFTER UPDATE ON device_backup
  FOR EACH ROW
  BEGIN
    UPDATE device_backup SET updated_at = strftime('%s','now') WHERE account_digest = OLD.account_digest;
  END;

-- 3. Devices
CREATE TABLE IF NOT EXISTS devices (
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (account_digest, device_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_account_status ON devices (account_digest, status);
CREATE INDEX IF NOT EXISTS idx_devices_account_seen ON devices (account_digest, status, last_seen_at);

-- 4. Device Signed Prekeys (Signal X3DH)
CREATE TABLE IF NOT EXISTS device_signed_prekeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  spk_id INTEGER NOT NULL,
  spk_pub TEXT NOT NULL,
  spk_sig TEXT NOT NULL,
  ik_pub TEXT, -- Added in 0015
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (account_digest, device_id, spk_id),
  FOREIGN KEY (account_digest, device_id) REFERENCES devices(account_digest, device_id) ON DELETE CASCADE
);

-- 5. Device OTP Keys (Signal One-Time Prekeys)
CREATE TABLE IF NOT EXISTS device_opks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  opk_id INTEGER NOT NULL,
  opk_pub TEXT NOT NULL,
  issued_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  consumed_at INTEGER,
  UNIQUE (account_digest, device_id, opk_id),
  FOREIGN KEY (account_digest, device_id) REFERENCES devices(account_digest, device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_opks_fetch ON device_opks (account_digest, device_id, consumed_at, opk_id);

-- 6. Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  token_b64 TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 7. Conversation ACL (Participants)
CREATE TABLE IF NOT EXISTS conversation_acl (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  device_id TEXT,
  role TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (conversation_id, account_digest, device_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_acl_account_device ON conversation_acl (account_digest, device_id);

CREATE TRIGGER IF NOT EXISTS trg_conversation_acl_updated
  AFTER UPDATE ON conversation_acl
  FOR EACH ROW
  BEGIN
    UPDATE conversation_acl
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id
       AND account_digest = OLD.account_digest
       AND (
         (device_id IS NULL AND OLD.device_id IS NULL) OR
         device_id = OLD.device_id
       );
  END;

-- 8. Secure Messages (Metadata for Fetching)
CREATE TABLE IF NOT EXISTS messages_secure (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_account_digest TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  receiver_account_digest TEXT NOT NULL,
  receiver_device_id TEXT,
  header_json TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  counter INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_secure_conv_ts ON messages_secure (conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_secure_sender_counter ON messages_secure (sender_account_digest, sender_device_id, counter);

-- 9. Attachments
CREATE TABLE IF NOT EXISTS attachments (
  object_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_account_digest TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  envelope_json TEXT,
  size_bytes INTEGER,
  content_type TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments (message_id);

-- 10. Groups
CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  creator_account_digest TEXT NOT NULL,
  name TEXT,
  avatar_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (creator_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_groups_conversation_id ON groups(conversation_id);
CREATE INDEX IF NOT EXISTS idx_groups_creator ON groups(creator_account_digest);

-- 11. Group Members
CREATE TABLE IF NOT EXISTS group_members (
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

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_account ON group_members(account_digest);
CREATE INDEX IF NOT EXISTS idx_group_members_status ON group_members(group_id, status);

-- 12. Group Invites
CREATE TABLE IF NOT EXISTS group_invites (
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

CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_expires ON group_invites(expires_at);

-- 13. Message Key Vault (E2EE Replay Keys)
CREATE TABLE IF NOT EXISTS message_key_vault (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  target_device_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  msg_type TEXT,
  header_counter INTEGER,
  wrapped_mk_json TEXT NOT NULL,
  wrap_context_json TEXT NOT NULL,
  dr_state_snapshot TEXT, -- Added in 0031
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(account_digest, conversation_id, message_id, sender_device_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_key_vault_unique
  ON message_key_vault (account_digest, conversation_id, message_id, sender_device_id);

CREATE INDEX IF NOT EXISTS idx_message_key_vault_lookup
  ON message_key_vault (account_digest, conversation_id, message_id, sender_device_id);

CREATE INDEX IF NOT EXISTS idx_message_key_vault_sender_lookup
  ON message_key_vault (account_digest, conversation_id, sender_device_id);

-- 14. Invite Dropbox (Offline Contact Init)
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
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), -- Added in 0028
  FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invite_dropbox_expires ON invite_dropbox(expires_at);
CREATE INDEX IF NOT EXISTS idx_invite_dropbox_status ON invite_dropbox(status);
CREATE INDEX IF NOT EXISTS idx_invite_dropbox_owner ON invite_dropbox(owner_account_digest);

-- 15. Contacts (Encrypted Metadata)
CREATE TABLE IF NOT EXISTS contacts (
  owner_digest TEXT NOT NULL,
  peer_digest TEXT NOT NULL,
  encrypted_blob TEXT,
  is_blocked INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (owner_digest, peer_digest)
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_digest);
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(owner_digest, updated_at);

-- 16. Call Sessions
CREATE TABLE IF NOT EXISTS call_sessions (
  call_id TEXT PRIMARY KEY,
  caller_uid TEXT NOT NULL,
  callee_uid TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status);
CREATE INDEX IF NOT EXISTS idx_call_sessions_expires ON call_sessions(expires_at);

-- 17. Call Events
CREATE TABLE IF NOT EXISTS call_events (
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

CREATE INDEX IF NOT EXISTS idx_call_events_call_created ON call_events(call_id, created_at DESC);

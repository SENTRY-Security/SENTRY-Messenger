-- 0019: Consolidated Schema v2
-- Full schema snapshot after migrations 0001-0018.
-- New deployments can start from this file; existing deployments skip via IF NOT EXISTS.
--
-- Supersedes: 0001 (base) + 0002 (missing tables) + 0004 (deletion log)
--             + 0007-0009 (invite/brand columns) + 0010 (ephemeral)
--             + 0011 (pending key exchange) + 0012 (token hash)
--             + 0013 (business conversations) + 0014 (backup reason)
--             + 0015 (push subscriptions) + 0016 (audit cleanup)
--             + 0017 (contacts zero-meta) + 0018 (audit indexes)
--
-- Tables removed (vs 0001): groups, group_members, group_invites (dropped in 0013)
-- Columns removed (vs 0001): accounts.uid_plain (0016), call_sessions.caller_uid/callee_uid (0016)
-- Indexes removed (vs 0001): idx_message_key_vault_unique, idx_message_key_vault_lookup (0016)

-- ============================================================
-- 1. Accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
  account_digest TEXT PRIMARY KEY,
  account_token TEXT NOT NULL,
  account_token_hash TEXT,
  uid_digest TEXT NOT NULL UNIQUE,
  last_ctr INTEGER NOT NULL DEFAULT 0,
  wrapped_mk_json TEXT,
  brand TEXT,
  brand_name TEXT,
  brand_logo TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ============================================================
-- 2. Device Backup (encrypted private keys)
-- ============================================================
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

-- ============================================================
-- 3. Devices
-- ============================================================
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
CREATE INDEX IF NOT EXISTS idx_devices_account_updated ON devices (account_digest, updated_at DESC, created_at DESC);

-- ============================================================
-- 4. Device Signed Prekeys (Signal X3DH)
-- ============================================================
CREATE TABLE IF NOT EXISTS device_signed_prekeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  device_id TEXT NOT NULL,
  spk_id INTEGER NOT NULL,
  spk_pub TEXT NOT NULL,
  spk_sig TEXT NOT NULL,
  ik_pub TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE (account_digest, device_id, spk_id),
  FOREIGN KEY (account_digest, device_id) REFERENCES devices(account_digest, device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_signed_prekeys_lookup ON device_signed_prekeys (account_digest, device_id, spk_id DESC);

-- ============================================================
-- 5. Device One-Time Prekeys (Signal OPKs)
-- ============================================================
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

-- ============================================================
-- 6. Conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  token_b64 TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ============================================================
-- 7. Conversation ACL (Participants)
-- ============================================================
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

-- ============================================================
-- 8. Secure Messages (E2EE ciphertext storage)
-- ============================================================
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
CREATE INDEX IF NOT EXISTS idx_messages_secure_counter_lookup ON messages_secure (conversation_id, sender_account_digest, sender_device_id, counter DESC);

-- ============================================================
-- 9. Attachments
-- ============================================================
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

-- ============================================================
-- 10. Message Key Vault (E2EE Replay Keys)
-- ============================================================
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
  dr_state_snapshot TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(account_digest, conversation_id, message_id, sender_device_id)
);

CREATE INDEX IF NOT EXISTS idx_message_key_vault_sender_lookup
  ON message_key_vault (account_digest, conversation_id, sender_device_id);

-- ============================================================
-- 11. Invite Dropbox (Offline Contact Init)
-- ============================================================
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
  pairing_code TEXT,
  prekey_bundle_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invite_dropbox_expires ON invite_dropbox(expires_at);
CREATE INDEX IF NOT EXISTS idx_invite_dropbox_status ON invite_dropbox(status);
CREATE INDEX IF NOT EXISTS idx_invite_dropbox_owner ON invite_dropbox(owner_account_digest);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_dropbox_pairing_code
  ON invite_dropbox(pairing_code) WHERE pairing_code IS NOT NULL AND status = 'CREATED';

-- ============================================================
-- 12. Contacts (Encrypted Metadata)
-- ============================================================
CREATE TABLE IF NOT EXISTS contacts (
  owner_digest TEXT NOT NULL,
  peer_digest TEXT NOT NULL,
  encrypted_blob TEXT,
  is_blocked INTEGER DEFAULT 0,
  slot_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (owner_digest, peer_digest)
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_digest);
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(owner_digest, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_owner_slot
  ON contacts(owner_digest, slot_id) WHERE slot_id IS NOT NULL;

-- ============================================================
-- 13. Call Sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS call_sessions (
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

CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status);
CREATE INDEX IF NOT EXISTS idx_call_sessions_expires ON call_sessions(expires_at);

-- ============================================================
-- 14. Call Events
-- ============================================================
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
CREATE INDEX IF NOT EXISTS idx_call_events_created_at ON call_events(created_at);

-- ============================================================
-- 15. Contact Secret Backups
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_secret_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  version INTEGER,
  payload_json TEXT,
  snapshot_version INTEGER,
  entries INTEGER,
  checksum TEXT,
  bytes INTEGER,
  device_label TEXT,
  device_id TEXT,
  reason TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_secret_backups_account ON contact_secret_backups(account_digest, updated_at DESC);

-- ============================================================
-- 16. OPAQUE Records
-- ============================================================
CREATE TABLE IF NOT EXISTS opaque_records (
  account_digest TEXT PRIMARY KEY,
  record_b64 TEXT NOT NULL,
  client_identity TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ============================================================
-- 17. Subscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  digest TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ============================================================
-- 18. Tokens
-- ============================================================
CREATE TABLE IF NOT EXISTS tokens (
  token_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  issued_at INTEGER,
  extend_days INTEGER,
  nonce TEXT,
  key_id TEXT,
  signature_b64 TEXT,
  status TEXT,
  used_at INTEGER,
  used_by_digest TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ============================================================
-- 19. Extend Logs
-- ============================================================
CREATE TABLE IF NOT EXISTS extend_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT,
  digest TEXT,
  extend_days INTEGER,
  expires_at_after INTEGER,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ============================================================
-- 20. Media Objects
-- ============================================================
CREATE TABLE IF NOT EXISTS media_objects (
  obj_key TEXT PRIMARY KEY,
  conv_id TEXT,
  sender_id TEXT,
  size_bytes INTEGER,
  content_type TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_media_objects_conv ON media_objects(conv_id);

-- ============================================================
-- 21. Deletion Cursors
-- ============================================================
CREATE TABLE IF NOT EXISTS deletion_cursors (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  min_counter INTEGER NOT NULL,
  min_ts REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (conversation_id, account_digest)
);

-- ============================================================
-- 22. Conversation Deletion Log
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_deletion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_digest TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  encrypted_checkpoint TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_deletion_log_lookup
  ON conversation_deletion_log (owner_digest, conversation_id, id ASC);

-- ============================================================
-- 23. Legacy Prekey Tables (required by worker checks)
-- ============================================================
CREATE TABLE IF NOT EXISTS prekey_users (
  account_digest TEXT PRIMARY KEY,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS prekey_opk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT,
  key_id INTEGER,
  public_key TEXT
);

-- ============================================================
-- 24. Ephemeral Invites
-- ============================================================
CREATE TABLE IF NOT EXISTS ephemeral_invites (
  token TEXT PRIMARY KEY,
  owner_digest TEXT NOT NULL,
  owner_device_id TEXT NOT NULL,
  prekey_bundle_json TEXT NOT NULL,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (owner_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ephemeral_invites_owner ON ephemeral_invites(owner_digest);
CREATE INDEX IF NOT EXISTS idx_ephemeral_invites_expires ON ephemeral_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_ephemeral_invites_cleanup ON ephemeral_invites(expires_at) WHERE consumed_at IS NULL;

-- ============================================================
-- 25. Ephemeral Sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS ephemeral_sessions (
  session_id TEXT PRIMARY KEY,
  invite_token TEXT NOT NULL,
  owner_digest TEXT NOT NULL,
  owner_device_id TEXT NOT NULL,
  guest_digest TEXT NOT NULL,
  guest_device_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  extended_count INTEGER NOT NULL DEFAULT 0,
  pending_key_exchange_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  deleted_at INTEGER,
  FOREIGN KEY (owner_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_owner ON ephemeral_sessions(owner_digest, deleted_at);
CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_guest ON ephemeral_sessions(guest_digest);
CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_conv ON ephemeral_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_expires ON ephemeral_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_guest_active ON ephemeral_sessions(guest_digest, expires_at) WHERE deleted_at IS NULL;

-- ============================================================
-- 26. Push Subscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  device_id TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  user_agent TEXT,
  preview_public_key TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_push_subs_account ON push_subscriptions(account_digest);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subs_endpoint ON push_subscriptions(endpoint);

-- ============================================================
-- 27. Business Conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS business_conversations (
  conversation_id TEXT PRIMARY KEY,
  owner_account_digest TEXT NOT NULL,
  encrypted_meta_blob TEXT,
  encrypted_policy_blob TEXT,
  key_epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'dissolved')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_biz_conv_owner ON business_conversations(owner_account_digest);
CREATE INDEX IF NOT EXISTS idx_biz_conv_status ON business_conversations(status);

-- ============================================================
-- 28. Business Conversation Members
-- ============================================================
CREATE TABLE IF NOT EXISTS business_conversation_members (
  conversation_id TEXT NOT NULL,
  account_digest TEXT NOT NULL,
  encrypted_role_blob TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'left', 'removed')),
  confirmed_epoch INTEGER NOT NULL DEFAULT 0,
  inviter_account_digest TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (conversation_id, account_digest),
  FOREIGN KEY (conversation_id)
    REFERENCES business_conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (account_digest)
    REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_biz_conv_members_account ON business_conversation_members(account_digest);
CREATE INDEX IF NOT EXISTS idx_biz_conv_members_status ON business_conversation_members(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_biz_conv_members_epoch ON business_conversation_members(conversation_id, confirmed_epoch);

-- ============================================================
-- 29. Business Conversation Tombstones
-- ============================================================
CREATE TABLE IF NOT EXISTS business_conversation_tombstones (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tombstone_type TEXT NOT NULL
    CHECK(tombstone_type IN (
      'member_joined',
      'member_left',
      'member_removed',
      'ownership_transferred',
      'policy_changed',
      'friend_added',
      'conversation_dissolved'
    )),
  encrypted_payload_blob TEXT NOT NULL,
  actor_account_digest TEXT,
  key_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (conversation_id)
    REFERENCES business_conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_biz_conv_tombstones_conv ON business_conversation_tombstones(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biz_conv_tombstones_type ON business_conversation_tombstones(conversation_id, tombstone_type);

-- ============================================================
-- Triggers for Business Conversations
-- ============================================================
CREATE TRIGGER IF NOT EXISTS trg_biz_conv_updated
  AFTER UPDATE ON business_conversations
  FOR EACH ROW
  BEGIN
    UPDATE business_conversations
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_biz_conv_members_updated
  AFTER UPDATE ON business_conversation_members
  FOR EACH ROW
  BEGIN
    UPDATE business_conversation_members
       SET updated_at = strftime('%s','now')
     WHERE conversation_id = OLD.conversation_id
       AND account_digest = OLD.account_digest;
  END;

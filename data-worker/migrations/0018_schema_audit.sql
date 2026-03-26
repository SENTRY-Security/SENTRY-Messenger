-- 0018: Database schema audit — add missing indexes for common query patterns
--
-- Findings from full codebase audit of worker.js and account-ws.js:
-- 1. device_signed_prekeys: lookup by (account_digest, device_id) ORDER BY spk_id DESC — no covering index
-- 2. messages_secure: MAX(counter) WHERE sender_account_digest, sender_device_id, conversation_id — no index
-- 3. call_events: DELETE WHERE created_at < ? (cleanup) — no created_at index
-- 4. ephemeral_invites: DELETE WHERE expires_at <= ? AND consumed_at IS NULL (cleanup) — partial index useful
-- 5. ephemeral_sessions: WHERE guest_digest = ? AND deleted_at IS NULL AND expires_at > ? — guest-side lookup
-- 6. devices: ORDER BY updated_at DESC — existing index covers (status, last_seen_at) but not updated_at

-- 1. device_signed_prekeys: fast lookup for latest SPK per account+device
--    Query: SELECT * FROM device_signed_prekeys WHERE account_digest=? AND device_id=? ORDER BY spk_id DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_device_signed_prekeys_lookup
  ON device_signed_prekeys(account_digest, device_id, spk_id DESC);

-- 2. messages_secure: fast MAX(counter) per sender in a conversation
--    Query: SELECT MAX(counter) FROM messages_secure WHERE conversation_id=? AND sender_account_digest=? AND sender_device_id=?
CREATE INDEX IF NOT EXISTS idx_messages_secure_counter_lookup
  ON messages_secure(conversation_id, sender_account_digest, sender_device_id, counter DESC);

-- 3. call_events: cleanup of expired events by created_at
--    Query: DELETE FROM call_events WHERE created_at < ?
CREATE INDEX IF NOT EXISTS idx_call_events_created_at
  ON call_events(created_at);

-- 4. ephemeral_invites: cleanup of expired unconsumed invites
--    Query: DELETE FROM ephemeral_invites WHERE expires_at <= ? AND consumed_at IS NULL
CREATE INDEX IF NOT EXISTS idx_ephemeral_invites_cleanup
  ON ephemeral_invites(expires_at)
  WHERE consumed_at IS NULL;

-- 5. ephemeral_sessions: guest-side active session lookup
--    Query: WHERE (owner_digest = ? OR guest_digest = ?) AND deleted_at IS NULL AND expires_at > ?
--    The owner_digest path is covered by idx_ephemeral_sessions_owner; this covers the guest_digest path.
CREATE INDEX IF NOT EXISTS idx_ephemeral_sessions_guest_active
  ON ephemeral_sessions(guest_digest, expires_at)
  WHERE deleted_at IS NULL;

-- 6. devices: fast latest-device lookup by updated_at
--    Query: SELECT device_id FROM devices WHERE account_digest=? ORDER BY updated_at DESC, created_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_devices_account_updated
  ON devices(account_digest, updated_at DESC, created_at DESC);

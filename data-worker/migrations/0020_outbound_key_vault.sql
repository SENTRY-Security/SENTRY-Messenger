-- Outbound Key Vault: persist wrapped outbound message keys for self-replay.
CREATE TABLE IF NOT EXISTS outbound_message_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  target_device_id TEXT,
  header_counter INTEGER NOT NULL,
  msg_type TEXT,
  wrapped_mk_json TEXT NOT NULL,
  wrap_context_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_message_keys_unique
  ON outbound_message_keys (account_digest, conversation_id, message_id, sender_device_id);

CREATE INDEX IF NOT EXISTS idx_outbound_message_keys_lookup
  ON outbound_message_keys (account_digest, conversation_id, sender_device_id, header_counter, created_at DESC);

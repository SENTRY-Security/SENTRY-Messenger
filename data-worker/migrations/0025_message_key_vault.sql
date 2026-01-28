-- Message Key Vault: persist wrapped message keys for replay (incoming + outgoing).
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
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(account_digest, conversation_id, message_id, sender_device_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_key_vault_unique
  ON message_key_vault (account_digest, conversation_id, message_id, sender_device_id);

CREATE INDEX IF NOT EXISTS idx_message_key_vault_lookup
  ON message_key_vault (account_digest, conversation_id, message_id, sender_device_id);

CREATE INDEX IF NOT EXISTS idx_message_key_vault_sender_lookup
  ON message_key_vault (account_digest, conversation_id, sender_device_id);

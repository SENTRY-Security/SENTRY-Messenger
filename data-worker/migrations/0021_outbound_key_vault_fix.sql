-- Ensure outbound_message_keys schema matches vault expectations (nullable header_counter, non-null wrap_context, target_device_id lookup).
CREATE TABLE IF NOT EXISTS outbound_message_keys_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  target_device_id TEXT,
  header_counter INTEGER,
  msg_type TEXT,
  wrapped_mk_json TEXT NOT NULL,
  wrap_context_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

INSERT INTO outbound_message_keys_v2 (
  id,
  account_digest,
  conversation_id,
  message_id,
  sender_device_id,
  target_device_id,
  header_counter,
  msg_type,
  wrapped_mk_json,
  wrap_context_json,
  created_at
) SELECT
  id,
  account_digest,
  conversation_id,
  message_id,
  sender_device_id,
  target_device_id,
  header_counter,
  msg_type,
  wrapped_mk_json,
  COALESCE(wrap_context_json, '{}'),
  COALESCE(created_at, strftime('%s','now'))
FROM outbound_message_keys;

DROP TABLE outbound_message_keys;
ALTER TABLE outbound_message_keys_v2 RENAME TO outbound_message_keys;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_message_keys_unique
  ON outbound_message_keys (account_digest, conversation_id, message_id, sender_device_id);

CREATE INDEX IF NOT EXISTS idx_outbound_message_keys_lookup
  ON outbound_message_keys (account_digest, conversation_id, sender_device_id, target_device_id, header_counter);

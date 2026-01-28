-- Receiver Checkpoints: persist wrapped DR receiver state per conversation/device for history replay.
CREATE TABLE IF NOT EXISTS receiver_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_digest TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  peer_device_id TEXT NOT NULL,
  cursor_message_id TEXT,
  cursor_server_message_id TEXT,
  header_counter INTEGER,
  nr INTEGER NOT NULL,
  ns INTEGER,
  pn INTEGER,
  their_ratchet_pub_hash TEXT,
  ckR_hash TEXT,
  skipped_hash TEXT,
  skipped_count INTEGER,
  wrap_info_tag TEXT,
  checkpoint_hash TEXT,
  wrapped_checkpoint_json TEXT NOT NULL,
  wrap_context_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_receiver_checkpoints_lookup
  ON receiver_checkpoints (account_digest, conversation_id, peer_device_id, nr DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_receiver_checkpoints_cursor
  ON receiver_checkpoints (account_digest, conversation_id, peer_device_id, cursor_message_id, cursor_server_message_id);

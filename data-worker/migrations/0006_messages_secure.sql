-- privacy-preserving messages storage
CREATE TABLE IF NOT EXISTS messages_secure (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_secure_conv_created
  ON messages_secure (conversation_id, created_at DESC);

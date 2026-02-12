-- Add conversation_deletion_log table (used by clear-history endpoints in worker.js)

CREATE TABLE IF NOT EXISTS conversation_deletion_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_digest         TEXT NOT NULL,
  conversation_id      TEXT NOT NULL,
  encrypted_checkpoint TEXT NOT NULL,
  created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_deletion_log_lookup
  ON conversation_deletion_log (owner_digest, conversation_id, id ASC);

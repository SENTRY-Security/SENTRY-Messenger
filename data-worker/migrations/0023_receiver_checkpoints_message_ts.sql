-- Receiver Checkpoints: add message_ts for replay lookup by message timestamp.
ALTER TABLE receiver_checkpoints ADD COLUMN message_ts INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows with their insertion timestamp.
UPDATE receiver_checkpoints
   SET message_ts = created_at
 WHERE message_ts IS NULL OR message_ts = 0;

CREATE INDEX IF NOT EXISTS idx_receiver_checkpoints_lookup_ts
  ON receiver_checkpoints (account_digest, conversation_id, peer_device_id, message_ts DESC, id DESC);

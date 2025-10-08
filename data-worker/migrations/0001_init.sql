-- tables
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text','media')),
  aead TEXT NOT NULL,
  header_json TEXT,
  obj_key TEXT,
  size_bytes INTEGER,
  ts INTEGER NOT NULL,
  FOREIGN KEY (conv_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_objects (
  obj_key TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);

-- indexes (must be separate in SQLite/D1)
CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages (conv_id, ts);
CREATE INDEX IF NOT EXISTS idx_media_conv ON media_objects (conv_id);

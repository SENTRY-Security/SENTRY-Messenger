-- Call session tracking tables

CREATE TABLE IF NOT EXISTS call_sessions (
  call_id TEXT PRIMARY KEY,
  caller_uid TEXT NOT NULL,
  callee_uid TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS call_events (
  event_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  from_uid TEXT,
  to_uid TEXT,
  trace_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (call_id) REFERENCES call_sessions(call_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_call_events_call_created ON call_events(call_id, created_at DESC);

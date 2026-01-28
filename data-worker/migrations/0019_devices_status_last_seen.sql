-- Add device presence tracking fields to devices.

-- Add status column if missing.
ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- Add last_seen_at column if missing.
ALTER TABLE devices ADD COLUMN last_seen_at INTEGER;

-- Indexes for active device lookups.
CREATE INDEX IF NOT EXISTS idx_devices_account_status ON devices (account_digest, status);
CREATE INDEX IF NOT EXISTS idx_devices_account_seen ON devices (account_digest, status, last_seen_at);

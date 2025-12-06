-- Add digest columns for call_events to remove UID dependency

ALTER TABLE call_events ADD COLUMN from_account_digest TEXT;
ALTER TABLE call_events ADD COLUMN to_account_digest TEXT;

-- Add min_ts column to deletion_cursors for timestamp-based filtering.
-- The existing min_counter column uses per-sender DR counters which are
-- not globally ordered across senders, causing messages from the lower-
-- counter sender to leak through the deletion filter.  min_ts stores
-- the created_at (seconds) of the last message at deletion time and
-- provides a correct cross-sender filter.

ALTER TABLE deletion_cursors ADD COLUMN min_ts REAL NOT NULL DEFAULT 0;

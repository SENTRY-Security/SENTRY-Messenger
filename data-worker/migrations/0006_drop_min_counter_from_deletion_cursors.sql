-- Drop min_counter from deletion_cursors.
-- Deletion filtering now uses min_ts (timestamp) exclusively.
-- SQLite does not support DROP COLUMN before 3.35.0; D1 uses a recent
-- SQLite build that supports it.

ALTER TABLE deletion_cursors DROP COLUMN min_counter;

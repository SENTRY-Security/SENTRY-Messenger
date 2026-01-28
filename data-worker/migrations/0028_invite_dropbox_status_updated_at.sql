-- Track updates and expired invites for invite_dropbox
ALTER TABLE invite_dropbox
  ADD COLUMN updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'));

UPDATE invite_dropbox
  SET updated_at = created_at
  WHERE updated_at IS NULL;

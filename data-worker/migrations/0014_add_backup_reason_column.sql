-- Add reason column to contact_secret_backups so biz-conv backups
-- are not trimmed by frequent contact-secrets backup uploads.
ALTER TABLE contact_secret_backups ADD COLUMN reason TEXT NOT NULL DEFAULT 'auto';

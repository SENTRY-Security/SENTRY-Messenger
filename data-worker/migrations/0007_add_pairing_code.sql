-- Add pairing code support for numeric friend-invite codes
ALTER TABLE invite_dropbox ADD COLUMN pairing_code TEXT;
ALTER TABLE invite_dropbox ADD COLUMN prekey_bundle_json TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_dropbox_pairing_code
  ON invite_dropbox(pairing_code)
  WHERE pairing_code IS NOT NULL AND status = 'CREATED';

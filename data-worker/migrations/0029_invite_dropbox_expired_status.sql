-- Backfill expired invite_dropbox status with updated_at touch (requires 0028)
UPDATE invite_dropbox
  SET status='EXPIRED',
      updated_at=strftime('%s','now')
  WHERE status IN ('CREATED', 'DELIVERED')
    AND expires_at <= strftime('%s','now');

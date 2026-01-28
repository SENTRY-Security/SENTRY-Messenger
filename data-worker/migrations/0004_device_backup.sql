

-- Device backup: stores wrapped device keys (IK/SPK privs & next_opk_id) as a single encrypted JSON blob.
-- Only ciphertext is stored. Decryption requires the user's MK (argon2id-derived KEK on the client).
-- NOTE: uid_hash 現階段先用 UID(HEX)；未來可改為 HMAC(uid, server_pepper) 後做資料遷移。

CREATE TABLE IF NOT EXISTS device_backup (
  uid_hash         TEXT PRIMARY KEY,
  wrapped_dev_json TEXT NOT NULL,                 -- {v,kdf,m,t,p,salt_b64,iv_b64,ct_b64}
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Keep updated_at fresh on writes
CREATE TRIGGER IF NOT EXISTS trg_device_backup_updated
AFTER UPDATE ON device_backup
FOR EACH ROW
BEGIN
  UPDATE device_backup SET updated_at = strftime('%s','now') WHERE uid_hash = OLD.uid_hash;
END;
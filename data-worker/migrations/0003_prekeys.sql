

-- Prekey tables for 1:1 conversations (X3DH bundle)
-- Stores per-UID identity & signed-prekey, and a pool of one-time prekeys (OPKs).
-- NOTE: uid_hash 現階段可直接使用 UID(HEX)；未來可改為 HMAC(uid, server_pepper) 後做資料遷移。

-- Users' static keys (identity & signed-prekey)
CREATE TABLE IF NOT EXISTS prekey_users (
  uid_hash    TEXT PRIMARY KEY,
  ik_pub      TEXT NOT NULL,              -- Identity public key (Curve25519), base64/hex
  spk_pub     TEXT NOT NULL,              -- Signed-prekey public
  spk_sig     TEXT NOT NULL,              -- Signature of spk_pub by IK (Ed25519/Curve25519 scheme per implementation)
  device_id   TEXT,                       -- optional: single-device for now; future multi-device
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- One-time prekeys pool
CREATE TABLE IF NOT EXISTS prekey_opk (
  uid_hash   TEXT NOT NULL,
  opk_id     INTEGER NOT NULL,            -- Provided by client or server; unique per uid_hash
  opk_pub    TEXT NOT NULL,               -- One-time prekey public (Curve25519), base64/hex
  used       INTEGER NOT NULL DEFAULT 0,  -- 0 = unused, 1 = consumed
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (uid_hash, opk_id),
  FOREIGN KEY (uid_hash) REFERENCES prekey_users(uid_hash) ON DELETE CASCADE
);

-- Index to fetch the next unused OPK quickly per user
CREATE INDEX IF NOT EXISTS idx_prekey_opk_unused ON prekey_opk (uid_hash, used, opk_id);

-- Trigger: keep updated_at fresh on updates to prekey_users
CREATE TRIGGER IF NOT EXISTS trg_prekey_users_updated
AFTER UPDATE ON prekey_users
FOR EACH ROW
BEGIN
  UPDATE prekey_users SET updated_at = strftime('%s','now') WHERE uid_hash = OLD.uid_hash;
END;
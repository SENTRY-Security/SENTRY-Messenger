-- Rebuild account-related tables to support accountToken/acct_digest architecture

DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS prekey_users;
DROP TABLE IF EXISTS prekey_opk;
DROP TABLE IF EXISTS device_backup;
DROP TABLE IF EXISTS friend_invites;

CREATE TABLE accounts (
  account_digest TEXT PRIMARY KEY,
  account_token TEXT NOT NULL,
  uid_digest TEXT NOT NULL UNIQUE,
  uid_plain TEXT,
  last_ctr INTEGER NOT NULL DEFAULT 0,
  wrapped_mk_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE prekey_users (
  account_digest TEXT PRIMARY KEY,
  ik_pub      TEXT NOT NULL,
  spk_pub     TEXT NOT NULL,
  spk_sig     TEXT NOT NULL,
  device_id   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE TABLE prekey_opk (
  account_digest TEXT NOT NULL,
  opk_id     INTEGER NOT NULL,
  opk_pub    TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (account_digest, opk_id),
  FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX idx_prekey_opk_unused ON prekey_opk (account_digest, used, opk_id);

CREATE TABLE device_backup (
  account_digest   TEXT PRIMARY KEY,
  wrapped_dev_json TEXT NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE TABLE friend_invites (
  invite_id TEXT PRIMARY KEY,
  owner_account_digest TEXT NOT NULL,
  owner_uid TEXT,
  secret TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  prekey_bundle TEXT,
  channel_seed TEXT,
  owner_contact_json TEXT,
  owner_contact_ts INTEGER,
  guest_account_digest TEXT,
  guest_uid TEXT,
  guest_contact_json TEXT,
  guest_contact_ts INTEGER,
  guest_bundle_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

CREATE INDEX idx_friend_invites_owner ON friend_invites(owner_account_digest);

CREATE TRIGGER trg_prekey_users_updated
  AFTER UPDATE ON prekey_users
  FOR EACH ROW
  BEGIN
    UPDATE prekey_users SET updated_at = strftime('%s','now') WHERE account_digest = OLD.account_digest;
  END;

CREATE TRIGGER trg_device_backup_updated
  AFTER UPDATE ON device_backup
  FOR EACH ROW
  BEGIN
    UPDATE device_backup SET updated_at = strftime('%s','now') WHERE account_digest = OLD.account_digest;
  END;

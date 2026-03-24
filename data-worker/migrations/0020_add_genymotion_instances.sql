-- 0020: Genymotion Android instances for App-as-a-Service
-- Maps each account to a Genymotion Cloud instance for virtual Android access.

CREATE TABLE IF NOT EXISTS genymotion_instances (
  account_digest   TEXT PRIMARY KEY,
  instance_uuid    TEXT NOT NULL,
  recipe_uuid      TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'starting',
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_active_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
);

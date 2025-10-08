-- tags: NTAG424 相關狀態（僅存最小必要資訊）
CREATE TABLE IF NOT EXISTS tags (
  uid_hash   TEXT PRIMARY KEY,               -- 建議先存 UID(HEX)；之後可換 HMAC(uid, pepper)
  last_ctr   INTEGER NOT NULL DEFAULT 0,     -- 單調遞增的 SDM 計數器（防重放）
  wrapped_mk_json TEXT,                      -- 前端以 argon2id 包裝後的 MK（JSON blob）
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
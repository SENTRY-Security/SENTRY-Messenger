-- d1-wipe-all.sql
--
-- *** 請務必確認執行環境只儲存測試資料 ***
-- 這個腳本會刪除 D1 中與訊息/好友/群組/通話/訂閱等相關的所有資料表內容（僅清資料，不改 schema）。
--
-- 執行方式：
--   npx wrangler d1 execute <DATABASE_NAME> --file scripts/cleanup/d1-wipe-all.sql
--

BEGIN TRANSACTION;

-- 先清除子表，再清父表，避免外鍵衝突
DELETE FROM call_events;
DELETE FROM call_sessions;
DELETE FROM group_invites;
DELETE FROM group_members;
DELETE FROM groups;
DELETE FROM contact_secret_backups;
DELETE FROM messages_secure;
DELETE FROM messages;
DELETE FROM media_objects;
DELETE FROM conversation_acl;
DELETE FROM conversations;
DELETE FROM friend_invites;
DELETE FROM prekey_opk;
DELETE FROM prekey_users;
DELETE FROM device_backup;
DELETE FROM opaque_records;
DELETE FROM extend_logs;
DELETE FROM tokens;
DELETE FROM subscriptions;
DELETE FROM tags;
DELETE FROM accounts;

COMMIT;

VACUUM;

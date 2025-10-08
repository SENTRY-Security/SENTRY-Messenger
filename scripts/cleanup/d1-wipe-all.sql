-- d1-wipe-all.sql
--
-- *** 請務必確認執行環境只儲存測試資料 ***
-- 這個腳本會刪除 D1 中與訊息/好友相關的所有資料表內容。
--
-- 執行方式：
--   npx wrangler d1 execute <DATABASE_NAME> --file scripts/cleanup/d1-wipe-all.sql
--

BEGIN TRANSACTION;

DELETE FROM messages;
DELETE FROM messages_secure;
DELETE FROM conversations;
DELETE FROM friend_invites;
DELETE FROM friend_requests;
DELETE FROM drive_index;
DELETE FROM drive_objects;

COMMIT;

VACUUM;

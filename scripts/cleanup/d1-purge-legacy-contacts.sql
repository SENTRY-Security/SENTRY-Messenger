-- d1-purge-legacy-contacts.sql
--
-- 清除 D1 中舊版（非 AES-256-GCM 包裝）的聯絡人資料。
-- 使用方式：
--   npx wrangler d1 execute <DATABASE_NAME> --file scripts/cleanup/d1-purge-legacy-contacts.sql
--
-- 建議先執行上方命令前，把 PREVIEW 區塊解除註解確認要刪除的筆數。

BEGIN TRANSACTION;

-- ==============================
-- OPTIONAL PREVIEW
-- ==============================
-- SELECT conv_id,
--        id,
--        json_extract(header_json, '$.peerUid')    AS peerUid,
--        json_extract(header_json, '$.envelope')   AS envelope,
--        ts
--   FROM messages
--  WHERE conv_id LIKE 'contacts-%'
--    AND json_extract(header_json, '$.contact') = 1
--    AND (
--         json_extract(header_json, '$.envelope.aead') IS NULL
--      OR json_extract(header_json, '$.envelope.aead') != 'aes-256-gcm'
--    )
--  ORDER BY ts DESC
--  LIMIT 50;

DELETE FROM messages
 WHERE conv_id LIKE 'contacts-%'
   AND json_extract(header_json, '$.contact') = 1
   AND (
        json_extract(header_json, '$.envelope.aead') IS NULL
     OR json_extract(header_json, '$.envelope.aead') != 'aes-256-gcm'
   );

DELETE FROM friend_invites
 WHERE (
         (owner_contact_json IS NOT NULL AND (
              json_extract(owner_contact_json, '$.aead') IS NULL
           OR json_extract(owner_contact_json, '$.aead') != 'aes-256-gcm'
         ))
      OR (guest_contact_json IS NOT NULL AND (
              json_extract(guest_contact_json, '$.aead') IS NULL
           OR json_extract(guest_contact_json, '$.aead') != 'aes-256-gcm'
         ))
       );

COMMIT;

-- Wipe all UAT D1 tables (DROP IF EXISTS to avoid "no such table" errors)
-- After running this, re-apply migrations to recreate the schema.
--
-- Order: child tables (with FOREIGN KEY) first, parent tables last.

-- ── Attachments & messages ──
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS messages_secure;
DROP TABLE IF EXISTS message_key_vault;

-- ── Conversation related ──
DROP TABLE IF EXISTS conversation_acl;
DROP TABLE IF EXISTS conversation_deletion_log;
DROP TABLE IF EXISTS ephemeral_sessions;
DROP TABLE IF EXISTS conversations;

-- ── Business conversations ──
DROP TABLE IF EXISTS business_conversation_tombstones;
DROP TABLE IF EXISTS business_conversation_members;
DROP TABLE IF EXISTS business_conversations;

-- ── Groups ──
DROP TABLE IF EXISTS group_invites;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;

-- ── Contacts ──
DROP TABLE IF EXISTS contact_secret_backups;
DROP TABLE IF EXISTS contacts;

-- ── Calls ──
DROP TABLE IF EXISTS call_events;
DROP TABLE IF EXISTS call_sessions;

-- ── Devices & prekeys ──
DROP TABLE IF EXISTS device_opks;
DROP TABLE IF EXISTS device_signed_prekeys;
DROP TABLE IF EXISTS device_backup;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS prekey_opk;
DROP TABLE IF EXISTS prekey_users;

-- ── Ephemeral ──
DROP TABLE IF EXISTS ephemeral_invites;

-- ── Auth & misc ──
DROP TABLE IF EXISTS opaque_records;
DROP TABLE IF EXISTS invite_dropbox;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS extend_logs;
DROP TABLE IF EXISTS media_objects;
DROP TABLE IF EXISTS deletion_cursors;
DROP TABLE IF EXISTS push_subscriptions;

-- ── Parent: accounts (last, since many tables reference it) ──
DROP TABLE IF EXISTS accounts;

-- ── D1 migration tracker (so migrations re-run from scratch) ──
DROP TABLE IF EXISTS d1_migrations;

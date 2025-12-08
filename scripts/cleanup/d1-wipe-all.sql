-- Clear messaging-related tables before reapplying migrations
DELETE FROM attachments;
DELETE FROM messages_secure;
DELETE FROM conversation_acl;
DELETE FROM conversations;
DELETE FROM device_opks;
DELETE FROM device_signed_prekeys;
DELETE FROM devices;

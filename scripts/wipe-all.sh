#!/bin/bash
set -e

echo "🗑️  Wiping all data from D1 database..."

cd "$(dirname "$0")/../data-worker"

npx wrangler d1 execute message_db --remote --command "
DELETE FROM accounts;
DELETE FROM attachments;
DELETE FROM call_events;
DELETE FROM call_sessions;
DELETE FROM contact_secret_backups;
DELETE FROM contacts;
DELETE FROM conversation_acl;
DELETE FROM conversations;
DELETE FROM device_backup;
DELETE FROM device_opks;
DELETE FROM device_signed_prekeys;
DELETE FROM devices;
DELETE FROM extend_logs;
DELETE FROM group_invites;
DELETE FROM group_members;
DELETE FROM groups;
DELETE FROM invite_dropbox;
DELETE FROM media_objects;
DELETE FROM message_key_vault;
DELETE FROM messages_secure;
DELETE FROM opaque_records;
DELETE FROM subscriptions;
DELETE FROM tokens;
"

echo "✅ All data wiped!"

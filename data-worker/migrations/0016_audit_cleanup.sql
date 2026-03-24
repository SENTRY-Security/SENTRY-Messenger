-- 0016: Database audit cleanup
-- 1. Drop accounts.uid_plain — plaintext UID violates encryption-at-rest policy; unused in code.
-- 2. Drop call_sessions.caller_uid / callee_uid — duplicates of caller/callee_account_digest; never serialized to clients.
-- 3. Drop redundant indexes on message_key_vault — the UNIQUE constraint already implies an index.

-- 1. Remove plaintext UID from accounts
ALTER TABLE accounts DROP COLUMN uid_plain;

-- 2. Remove redundant UID columns from call_sessions
ALTER TABLE call_sessions DROP COLUMN caller_uid;
ALTER TABLE call_sessions DROP COLUMN callee_uid;

-- 3. Remove redundant indexes on message_key_vault
--    The table-level UNIQUE(account_digest, conversation_id, message_id, sender_device_id)
--    already creates an implicit index. The explicit UNIQUE INDEX and regular INDEX are redundant.
DROP INDEX IF EXISTS idx_message_key_vault_unique;
DROP INDEX IF EXISTS idx_message_key_vault_lookup;

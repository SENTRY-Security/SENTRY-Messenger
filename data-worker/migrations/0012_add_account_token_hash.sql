-- C-1 Phase 1: Add account_token_hash column for secure token storage
-- Nullable initially — populated on next login, fallback to plaintext for legacy accounts
ALTER TABLE accounts ADD COLUMN account_token_hash TEXT;

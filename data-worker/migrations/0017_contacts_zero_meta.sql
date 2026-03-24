-- 0017: Zero-meta Phase 0-A — Hide peer_digest from contacts table.
--
-- Problem: (owner_digest, peer_digest) composite PK exposes the full social
-- graph to the server. The server can enumerate every contact relationship.
--
-- Solution: Replace peer_digest with a client-derived opaque slot_id
-- (HMAC(contact_storage_key, peer_digest)). The peer_digest and is_blocked
-- fields move inside the encrypted_blob. During the transition period both
-- formats coexist; clients migrate legacy rows on next login.

-- 1. Add slot_id column (nullable during transition)
ALTER TABLE contacts ADD COLUMN slot_id TEXT;

-- 2. Index for new-format lookups: (owner_digest, slot_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_owner_slot
  ON contacts(owner_digest, slot_id)
  WHERE slot_id IS NOT NULL;

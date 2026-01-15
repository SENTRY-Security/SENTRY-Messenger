-- Contact List Storage
-- Allows fast restoration of contact list without replaying message history.
-- Relationships are visible (SOCIAL GRAPH RISK), but metadata (Nickname, Avatar) is encrypted.

CREATE TABLE IF NOT EXISTS contacts (
  owner_digest TEXT NOT NULL,         -- Account Digest of the user who owns this list
  peer_digest TEXT NOT NULL,          -- Account Digest of the contact
  encrypted_blob TEXT,                -- Encrypted JSON: { nickname, note, avatar_ref: { key, ... } }
  is_blocked INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (owner_digest, peer_digest)
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_digest);
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(owner_digest, updated_at);

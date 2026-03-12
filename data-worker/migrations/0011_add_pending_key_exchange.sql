-- Add pending_key_exchange_json column to ephemeral_sessions.
-- When the WS relay fails to deliver a key-exchange message (e.g. owner tab
-- backgrounded), the guest can POST the bundle via HTTP and the server stores
-- it here. The owner picks it up on the next _loadSessions poll.

ALTER TABLE ephemeral_sessions ADD COLUMN pending_key_exchange_json TEXT;

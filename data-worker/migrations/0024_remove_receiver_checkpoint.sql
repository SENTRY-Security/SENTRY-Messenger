-- Remove legacy receiver checkpoints and outbound key vault tables.
DROP TABLE IF EXISTS receiver_checkpoints;
DROP TABLE IF EXISTS outbound_message_keys;
DROP TABLE IF EXISTS outbound_message_keys_v2;

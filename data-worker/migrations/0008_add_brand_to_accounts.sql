-- Add brand column to accounts for multi-brand support.
-- The admin system sets this per-account; frontend reads it via SDM exchange.
ALTER TABLE accounts ADD COLUMN brand TEXT;

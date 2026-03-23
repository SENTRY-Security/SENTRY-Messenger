-- Add brand display metadata columns for multi-brand white-label support.
-- brand_name: display name (e.g. "ACME MESSENGER")
-- brand_logo: logo URL (can be absolute external URL or relative path)
ALTER TABLE accounts ADD COLUMN brand_name TEXT;
ALTER TABLE accounts ADD COLUMN brand_logo TEXT;

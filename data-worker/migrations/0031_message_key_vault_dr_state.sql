-- Add dr_state_snapshot column to message_key_vault
ALTER TABLE message_key_vault ADD COLUMN dr_state_snapshot TEXT;

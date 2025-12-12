-- Add IK public key to device_signed_prekeys for per-device Signal bundles
ALTER TABLE device_signed_prekeys
  ADD COLUMN ik_pub TEXT;

-- Migration 071: allow simple BLE devices to reuse the same 32-character
-- nonce across separate verification qualifications. Paste this whole file
-- into the Tencent CloudBase PostgreSQL SQL editor and execute it once.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.verification_ble_authorizations') IS NULL THEN
    RAISE EXCEPTION 'migration 071 requires migration 066';
  END IF;
END;
$$;

LOCK TABLE public.verification_ble_authorizations IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.verification_ble_authorizations
  DROP CONSTRAINT IF EXISTS verification_ble_authorizations_device_id_nonce_key;

CREATE INDEX IF NOT EXISTS idx_verification_ble_authorization_device_nonce
  ON public.verification_ble_authorizations (device_id, nonce, created_at DESC);

COMMENT ON COLUMN public.verification_ble_authorizations.nonce IS
  'Device-provided 32-character hexadecimal session value. Reuse across separate qualifications is allowed from migration 071; qualification_id and authorization_token remain unique.';

COMMIT;

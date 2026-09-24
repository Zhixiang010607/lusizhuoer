-- Migration 069: accept the supplier-confirmed Magic Soft Skin BLE identity
-- while retaining the original NCM identifier format for other devices.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.verification_ble_qualifications') IS NULL
     OR TO_REGCLASS('public.verification_ble_authorizations') IS NULL THEN
    RAISE EXCEPTION 'migration 069 requires migration 066 BLE tables';
  END IF;
END;
$$;

LOCK TABLE public.verification_ble_qualifications,
           public.verification_ble_authorizations
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.verification_ble_qualifications
  DROP CONSTRAINT IF EXISTS verification_ble_qualifications_expected_device_type_check;
ALTER TABLE public.verification_ble_qualifications
  ADD CONSTRAINT verification_ble_qualifications_expected_device_type_check
  CHECK (expected_device_type ~ '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$');

ALTER TABLE public.verification_ble_authorizations
  DROP CONSTRAINT IF EXISTS verification_ble_authorizations_qr_sn_check;
ALTER TABLE public.verification_ble_authorizations
  ADD CONSTRAINT verification_ble_authorizations_qr_sn_check
  CHECK (qr_sn ~ '^(NCM[0-9A-F]{11}|LA[0-9A-F]{12})$');

ALTER TABLE public.verification_ble_authorizations
  DROP CONSTRAINT IF EXISTS verification_ble_authorizations_device_type_check;
ALTER TABLE public.verification_ble_authorizations
  ADD CONSTRAINT verification_ble_authorizations_device_type_check
  CHECK (device_type ~ '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$');

COMMENT ON COLUMN public.verification_ble_qualifications.expected_device_type IS
  'Canonical BLE type. Magic Soft Skin uses LASER-BLE; legacy project-derived identifiers remain supported.';
COMMENT ON COLUMN public.verification_ble_authorizations.qr_sn IS
  'BLE device serial from QR. Supports LA plus 12 uppercase hex digits and legacy NCM plus 11 uppercase hex digits.';

COMMIT;

-- Migration 066 follow-up: retire the obsolete BLE device registry.
--
-- The final protocol does not use a database device registry.  Device identity
-- is checked from the QR serial number, live BLE get_info response, nonce,
-- short validity windows and the shared HMAC-SHA256 key.  This script is
-- idempotent: environments that never created the legacy table are unchanged.

BEGIN;

DROP TABLE IF EXISTS public.verification_ble_devices;

COMMIT;

SELECT 'BLE device registry absent' AS check_name,
       0 AS record_count,
       CASE
         WHEN TO_REGCLASS('public.verification_ble_devices') IS NULL THEN 'READY'
         ELSE 'CHECK'
       END AS status;

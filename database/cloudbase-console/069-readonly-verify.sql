SELECT 'magic device QR serial accepted' AS check_name,
       COUNT(*) AS record_count,
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END AS status
FROM pg_constraint
WHERE conrelid = 'public.verification_ble_authorizations'::regclass
  AND conname = 'verification_ble_authorizations_qr_sn_check'
  AND pg_get_constraintdef(oid) LIKE '%LA[0-9A-F]{12}%'
UNION ALL
SELECT 'hyphenated qualification device type accepted', COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
FROM pg_constraint
WHERE conrelid = 'public.verification_ble_qualifications'::regclass
  AND conname = 'verification_ble_qualifications_expected_device_type_check'
  AND pg_get_constraintdef(oid) LIKE '%A-Za-z0-9%-%'
UNION ALL
SELECT 'hyphenated authorization device type accepted', COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
FROM pg_constraint
WHERE conrelid = 'public.verification_ble_authorizations'::regclass
  AND conname = 'verification_ble_authorizations_device_type_check'
  AND pg_get_constraintdef(oid) LIKE '%A-Za-z0-9%-%';

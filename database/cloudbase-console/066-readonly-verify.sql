-- Migration 066 read-only acceptance checks.
-- Expected result: every row reports READY.

WITH required_tables(name) AS (
  VALUES
    ('verification_ble_qualifications'),
    ('verification_ble_authorizations'),
    ('verification_ble_devices')
)
SELECT 'BLE tables present' AS check_name,
       COUNT(*) AS record_count,
       CASE WHEN COUNT(*) = 3 THEN 'READY' ELSE 'CHECK' END AS status
  FROM required_tables
 WHERE TO_REGCLASS('public.' || name) IS NOT NULL
UNION ALL
SELECT 'BLE tables have RLS', COUNT(*),
       CASE WHEN COUNT(*) = 3 THEN 'READY' ELSE 'CHECK' END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('verification_ble_qualifications', 'verification_ble_authorizations', 'verification_ble_devices')
   AND c.relrowsecurity
UNION ALL
SELECT 'client table access closed', COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'UNSAFE' END
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('verification_ble_qualifications', 'verification_ble_authorizations', 'verification_ble_devices')
   AND grantee IN ('PUBLIC', 'anon', 'authenticated')
UNION ALL
SELECT 'client sequence access closed', COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'UNSAFE' END
  FROM information_schema.role_usage_grants
 WHERE object_schema = 'public'
   AND object_name IN ('verification_ble_qualifications_id_seq', 'verification_ble_authorizations_id_seq', 'verification_ble_devices_id_seq')
   AND grantee IN ('PUBLIC', 'anon', 'authenticated')
UNION ALL
SELECT 'service role retained', COUNT(DISTINCT table_name),
       CASE WHEN COUNT(DISTINCT table_name) = 3 THEN 'READY' ELSE 'CHECK' END
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('verification_ble_qualifications', 'verification_ble_authorizations', 'verification_ble_devices')
   AND grantee = 'service_role'
UNION ALL
SELECT '90 second qualification constraint', COUNT(*),
       CASE WHEN COUNT(*) >= 1 THEN 'READY' ELSE 'CHECK' END
  FROM pg_constraint
 WHERE conrelid = TO_REGCLASS('public.verification_ble_qualifications')
   AND pg_get_constraintdef(oid) ILIKE '%90 seconds%'
UNION ALL
SELECT '30 second authorization constraint', COUNT(*),
       CASE WHEN COUNT(*) >= 1 THEN 'READY' ELSE 'CHECK' END
  FROM pg_constraint
 WHERE conrelid = TO_REGCLASS('public.verification_ble_authorizations')
   AND pg_get_constraintdef(oid) ILIKE '%30 seconds%'
UNION ALL
SELECT 'plaintext pairing absent', COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'UNSAFE' END
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('verification_ble_devices', 'verification_ble_authorizations')
   AND column_name IN ('pairing_code', 'qr_code')
UNION ALL
SELECT 'stored qualification windows valid', COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
  FROM public.verification_ble_qualifications
 WHERE expires_at <= created_at
    OR expires_at > created_at + INTERVAL '90 seconds'
UNION ALL
SELECT 'stored authorization windows valid', COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
  FROM public.verification_ble_authorizations
 WHERE expires_at <= issued_at
    OR expires_at > issued_at + INTERVAL '30 seconds';

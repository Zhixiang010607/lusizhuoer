-- Migration 071 read-only acceptance checks.
-- Expected result: every row reports READY.

SELECT 'device nonce global unique constraint removed' AS check_name,
       COUNT(*) AS conflicting_constraint_count,
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END AS status
  FROM pg_constraint
 WHERE conrelid = TO_REGCLASS('public.verification_ble_authorizations')
   AND contype = 'u'
   AND REGEXP_REPLACE(pg_get_constraintdef(oid), '\\s+', ' ', 'g')
       ILIKE 'UNIQUE (device_id, nonce)'
UNION ALL
SELECT 'qualification remains one authorization only',
       COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
  FROM pg_constraint
 WHERE conrelid = TO_REGCLASS('public.verification_ble_authorizations')
   AND contype = 'u'
   AND REGEXP_REPLACE(pg_get_constraintdef(oid), '\\s+', ' ', 'g')
       ILIKE 'UNIQUE (qualification_id)'
UNION ALL
SELECT 'authorization token remains unique',
       COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
  FROM pg_constraint
 WHERE conrelid = TO_REGCLASS('public.verification_ble_authorizations')
   AND contype = 'u'
   AND REGEXP_REPLACE(pg_get_constraintdef(oid), '\\s+', ' ', 'g')
       ILIKE 'UNIQUE (authorization_token)'
UNION ALL
SELECT 'device nonce audit index present',
       COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename = 'verification_ble_authorizations'
   AND indexname = 'idx_verification_ble_authorization_device_nonce';

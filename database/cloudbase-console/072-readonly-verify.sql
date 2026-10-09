-- Migration 072 read-only acceptance checks.
-- Expected result: every row reports READY and both overbook counts are zero.

SELECT 'qualification reservation column present' AS check_name,
       COUNT(*) AS record_count,
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END AS status
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'verification_ble_qualifications'
   AND column_name = 'units_reserved_at'
UNION ALL
SELECT 'atomic reservation function present',
       COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
  FROM pg_proc
 WHERE oid = TO_REGPROCEDURE('public.reserve_verification_ble_units(bigint)')
UNION ALL
SELECT 'reservation lookup index present',
       COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename = 'verification_ble_qualifications'
   AND indexname = 'idx_verification_ble_qualification_unit_reservation'
UNION ALL
SELECT 'live authorization without reservation',
       COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
  FROM public.verification_ble_qualifications AS qualification
  JOIN public.verification_ble_authorizations AS ble_authorization
    ON ble_authorization.qualification_id = qualification.id
 WHERE qualification.verification_id IS NULL
   AND qualification.expires_at > CLOCK_TIMESTAMP()
   AND qualification.units_reserved_at IS NULL
   AND (
     ble_authorization.authorization_status = 'DEVICE_WORKING'
     OR (
       ble_authorization.authorization_status = 'ISSUED'
       AND ble_authorization.expires_at > CLOCK_TIMESTAMP()
     )
   )
UNION ALL
SELECT 'overbooked active NORMAL reservation buckets',
       COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
  FROM (
    SELECT qualification.customer_id, qualification.product_id
      FROM public.verification_ble_qualifications AS qualification
      LEFT JOIN public.customer_product_balances AS balance
        ON balance.customer_id = qualification.customer_id
       AND balance.product_id = qualification.product_id
     WHERE qualification.verification_type = 'NORMAL'
       AND qualification.units_reserved_at IS NOT NULL
       AND qualification.verification_id IS NULL
       AND qualification.qualification_status NOT IN ('COMPLETED', 'EXPIRED', 'CANCELLED')
       AND qualification.expires_at > CLOCK_TIMESTAMP()
     GROUP BY qualification.customer_id, qualification.product_id,
              balance.remaining_count
    HAVING SUM(qualification.unit_count) > COALESCE(balance.remaining_count, 0)
  ) AS conflict
UNION ALL
SELECT 'overbooked active EXPERIENCE reservation buckets',
       COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
  FROM (
    SELECT qualification.teacher_id, qualification.product_id
      FROM public.verification_ble_qualifications AS qualification
      LEFT JOIN public.teacher_product_experience_quotas AS quota
        ON quota.teacher_id = qualification.teacher_id
       AND quota.product_id = qualification.product_id
       AND quota.quota_status = 'ACTIVE'
     WHERE qualification.verification_type = 'EXPERIENCE'
       AND qualification.units_reserved_at IS NOT NULL
       AND qualification.verification_id IS NULL
       AND qualification.qualification_status NOT IN ('COMPLETED', 'EXPIRED', 'CANCELLED')
       AND qualification.expires_at > CLOCK_TIMESTAMP()
     GROUP BY qualification.teacher_id, qualification.product_id,
              quota.available_count
    HAVING SUM(qualification.unit_count) > COALESCE(quota.available_count, 0)
  ) AS conflict;

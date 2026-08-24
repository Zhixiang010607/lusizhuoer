-- Migration 059 read-only store binding preflight.
WITH layout AS (
  SELECT
    (SELECT COUNT(DISTINCT column_name) = 3
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stores'
        AND column_name IN ('id', 'store_account_id', 'store_status')) AS has_current,
    TO_REGCLASS('public.staff_store_assignments') IS NOT NULL
      AND (SELECT COUNT(DISTINCT column_name) = 3
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'staff_store_assignments'
              AND column_name IN ('staff_account_id', 'store_id', 'assignment_status'))
      AND (SELECT COUNT(DISTINCT column_name) = 2
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'stores'
              AND column_name IN ('id', 'store_status')) AS has_legacy
), checks AS (
  SELECT 'current store binding layout'::text AS check_name,
         CASE WHEN has_current THEN 1 ELSE 0 END::bigint AS record_count,
         CASE WHEN has_current THEN 'READY' ELSE 'NOT_PRESENT' END::text AS status
    FROM layout
  UNION ALL
  SELECT 'legacy store binding layout',
         CASE WHEN has_legacy THEN 1 ELSE 0 END::bigint,
         CASE WHEN has_legacy THEN 'READY' ELSE 'NOT_PRESENT' END
    FROM layout
  UNION ALL
  SELECT 'selected store binding layout',
         CASE WHEN has_current OR has_legacy THEN 1 ELSE 0 END::bigint,
         CASE WHEN has_current THEN 'READY_CURRENT'
              WHEN has_legacy THEN 'READY_LEGACY'
              ELSE 'MISSING' END
    FROM layout
)
SELECT check_name, record_count, status FROM checks ORDER BY check_name;

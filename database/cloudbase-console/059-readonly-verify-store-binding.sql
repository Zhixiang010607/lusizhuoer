-- Migration 059 read-only store binding verification.
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
)
SELECT 'database_layout' AS object_group,
       'store_account_binding' AS object_name,
       CASE WHEN has_current OR has_legacy THEN 'READY' ELSE 'MISSING' END AS status
FROM layout;

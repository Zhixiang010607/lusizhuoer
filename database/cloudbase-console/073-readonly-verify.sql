-- Read-only verification for migration 073. All seven rows must be READY.

SELECT 'staff daily reports table' AS check_name,
       CASE WHEN TO_REGCLASS('public.staff_daily_reports') IS NOT NULL
            THEN 0 ELSE 1 END AS record_count,
       CASE WHEN TO_REGCLASS('public.staff_daily_reports') IS NOT NULL
            THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'one report per staff and date constraint',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.staff_daily_reports'::regclass
            AND conname = 'uq_staff_daily_reports_account_date'
       ) THEN 0 ELSE 1 END,
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.staff_daily_reports'::regclass
            AND conname = 'uq_staff_daily_reports_account_date'
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'Shanghai today-only write trigger',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'public.staff_daily_reports'::regclass
            AND tgname = 'trg_staff_daily_report_today_v73'
            AND NOT tgisinternal
       ) THEN 0 ELSE 1 END,
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'public.staff_daily_reports'::regclass
            AND tgname = 'trg_staff_daily_report_today_v73'
            AND NOT tgisinternal
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'historical delete blocked in trigger body',
       CASE WHEN LOWER(PG_GET_FUNCTIONDEF(
         'public.enforce_staff_daily_report_today_v73()'::regprocedure
       )) LIKE '%daily reports cannot be deleted%' THEN 0 ELSE 1 END,
       CASE WHEN LOWER(PG_GET_FUNCTIONDEF(
         'public.enforce_staff_daily_report_today_v73()'::regprocedure
       )) LIKE '%daily reports cannot be deleted%' THEN 'READY' ELSE 'UNSAFE' END
UNION ALL
SELECT 'active teacher-only write guard',
       CASE WHEN LOWER(PG_GET_FUNCTIONDEF(
         'public.enforce_staff_daily_report_today_v73()'::regprocedure
       )) LIKE '%restricted to active teacher accounts%' THEN 0 ELSE 1 END,
       CASE WHEN LOWER(PG_GET_FUNCTIONDEF(
         'public.enforce_staff_daily_report_today_v73()'::regprocedure
       )) LIKE '%restricted to active teacher accounts%' THEN 'READY' ELSE 'UNSAFE' END
UNION ALL
SELECT 'client daily report table access closed',
       CASE WHEN NOT HAS_TABLE_PRIVILEGE('anon', 'public.staff_daily_reports', 'SELECT,INSERT,UPDATE,DELETE')
                  AND NOT HAS_TABLE_PRIVILEGE('authenticated', 'public.staff_daily_reports', 'SELECT,INSERT,UPDATE,DELETE')
            THEN 0 ELSE 1 END,
       CASE WHEN NOT HAS_TABLE_PRIVILEGE('anon', 'public.staff_daily_reports', 'SELECT,INSERT,UPDATE,DELETE')
                  AND NOT HAS_TABLE_PRIVILEGE('authenticated', 'public.staff_daily_reports', 'SELECT,INSERT,UPDATE,DELETE')
            THEN 'READY' ELSE 'UNSAFE' END
UNION ALL
SELECT 'service role daily report access retained',
       CASE WHEN HAS_TABLE_PRIVILEGE('service_role', 'public.staff_daily_reports', 'SELECT,INSERT,UPDATE')
                  AND NOT HAS_TABLE_PRIVILEGE('service_role', 'public.staff_daily_reports', 'DELETE')
            THEN 0 ELSE 1 END,
       CASE WHEN HAS_TABLE_PRIVILEGE('service_role', 'public.staff_daily_reports', 'SELECT,INSERT,UPDATE')
                  AND NOT HAS_TABLE_PRIVILEGE('service_role', 'public.staff_daily_reports', 'DELETE')
            THEN 'READY' ELSE 'UNSAFE' END;

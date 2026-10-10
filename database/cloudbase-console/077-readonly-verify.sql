SELECT 'daily_report_all_fields_constraint' AS item,
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = TO_REGCLASS('public.staff_daily_reports')
            AND conname = 'staff_daily_reports_all_fields_required_v77'
       ) THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'daily_report_all_fields_trigger',
       CASE WHEN POSITION('all four daily report fields are required' IN PG_GET_FUNCTIONDEF(
         TO_REGPROCEDURE('public.enforce_staff_daily_report_today_v73()')
       )) > 0 THEN 'READY' ELSE 'MISSING' END;

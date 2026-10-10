SELECT 'daily_report_single_field_constraint' AS item,
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = TO_REGCLASS('public.staff_daily_reports')
            AND conname = 'staff_daily_reports_completed_work_v84'
       ) THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'daily_report_four_field_constraint_retired',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = TO_REGCLASS('public.staff_daily_reports')
            AND conname = 'staff_daily_reports_all_fields_required_v77'
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'daily_report_single_field_trigger',
       CASE WHEN POSITION('daily report completed work is required and limited to 1000 characters' IN PG_GET_FUNCTIONDEF(
         TO_REGPROCEDURE('public.enforce_staff_daily_report_today_v73()')
       )) > 0 THEN 'READY' ELSE 'MISSING' END;

-- Migration 074 read-only verification. The row must report READY.

SELECT 'daily report date index' AS check_name,
       CASE WHEN TO_REGCLASS('public.idx_staff_daily_reports_report_date_account') IS NOT NULL
         THEN 'READY' ELSE 'MISSING' END AS status;

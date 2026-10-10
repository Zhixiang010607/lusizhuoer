-- Migration 074: HQ daily-report tracking query index.
-- The tracker reads every active teacher for one selected report date, so add
-- a date-first index without changing existing report or teacher data.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.staff_daily_reports') IS NULL THEN
    RAISE EXCEPTION 'migration 074 requires migration 073';
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_staff_daily_reports_report_date_account
  ON public.staff_daily_reports (report_date DESC, staff_account_id);

COMMIT;

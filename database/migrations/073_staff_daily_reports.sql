-- Migration 073: self-service teacher daily reports.
-- Every active teacher account owns at most one report per Shanghai business day.
-- Teachers may create or update only today's report; historical reports are
-- immutable and physical deletion is prohibited.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL THEN
    RAISE EXCEPTION 'migration 073 requires public.staff_accounts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'migration 073 requires the CloudBase service_role';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.staff_daily_reports (
  id BIGSERIAL PRIMARY KEY,
  staff_account_id BIGINT NOT NULL
    REFERENCES public.staff_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  report_date DATE NOT NULL,
  completed_work TEXT NOT NULL,
  customer_project_progress TEXT NOT NULL DEFAULT '',
  problems_and_support TEXT NOT NULL DEFAULT '',
  tomorrow_plan TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_staff_daily_reports_account_date
    UNIQUE (staff_account_id, report_date),
  CONSTRAINT staff_daily_reports_completed_work_check
    CHECK (CHAR_LENGTH(BTRIM(completed_work)) BETWEEN 1 AND 2000),
  CONSTRAINT staff_daily_reports_progress_check
    CHECK (CHAR_LENGTH(customer_project_progress) <= 2000),
  CONSTRAINT staff_daily_reports_problems_check
    CHECK (CHAR_LENGTH(problems_and_support) <= 2000),
  CONSTRAINT staff_daily_reports_tomorrow_plan_check
    CHECK (CHAR_LENGTH(tomorrow_plan) <= 2000)
);

CREATE INDEX IF NOT EXISTS idx_staff_daily_reports_account_month
  ON public.staff_daily_reports (staff_account_id, report_date DESC);

CREATE OR REPLACE FUNCTION public.enforce_staff_daily_report_today_v73()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  shanghai_today DATE := (CLOCK_TIMESTAMP() AT TIME ZONE 'Asia/Shanghai')::DATE;
  valid_teacher BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employee daily reports cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.staff_account_id IS DISTINCT FROM OLD.staff_account_id
    OR NEW.report_date IS DISTINCT FROM OLD.report_date
    OR OLD.report_date IS DISTINCT FROM shanghai_today
  ) THEN
    RAISE EXCEPTION 'historical employee daily reports are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.report_date IS DISTINCT FROM shanghai_today THEN
    RAISE EXCEPTION 'employee daily reports may only be written for the current Shanghai date'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.staff_accounts AS account
      JOIN public.teachers AS teacher ON teacher.staff_account_id = account.id
     WHERE account.id = NEW.staff_account_id
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
       AND teacher.teacher_status = 'ACTIVE'
  ) INTO valid_teacher;
  IF NOT valid_teacher THEN
    RAISE EXCEPTION 'daily reports are restricted to active teacher accounts'
      USING ERRCODE = '23514';
  END IF;

  NEW.completed_work := BTRIM(NEW.completed_work);
  NEW.customer_project_progress := BTRIM(COALESCE(NEW.customer_project_progress, ''));
  NEW.problems_and_support := BTRIM(COALESCE(NEW.problems_and_support, ''));
  NEW.tomorrow_plan := BTRIM(COALESCE(NEW.tomorrow_plan, ''));
  NEW.updated_at := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_daily_report_today_v73
  ON public.staff_daily_reports;
CREATE TRIGGER trg_staff_daily_report_today_v73
BEFORE INSERT OR UPDATE OR DELETE ON public.staff_daily_reports
FOR EACH ROW EXECUTE FUNCTION public.enforce_staff_daily_report_today_v73();

REVOKE ALL ON TABLE public.staff_daily_reports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.staff_daily_reports_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_staff_daily_report_today_v73()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.staff_daily_reports FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.staff_daily_reports TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.staff_daily_reports_id_seq TO service_role;

COMMENT ON TABLE public.staff_daily_reports IS
  'Migration 073: one self-authored daily report per active teacher account and Shanghai business date; only today is editable and deletion is forbidden.';
COMMENT ON FUNCTION public.enforce_staff_daily_report_today_v73() IS
  'Migration 073: database authority for Shanghai-today-only daily report writes and immutable history.';

COMMIT;

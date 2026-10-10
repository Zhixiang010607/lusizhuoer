-- Migration 084: make "completed work" the only writable daily-report field.
-- Historical reports are preserved. New and same-day updated reports accept
-- UTF-8 text (including emoji and other special symbols) up to 1000 characters.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.staff_daily_reports') IS NULL THEN
    RAISE EXCEPTION 'migration 084 requires public.staff_daily_reports';
  END IF;
END;
$$;

ALTER TABLE public.staff_daily_reports
  DROP CONSTRAINT IF EXISTS staff_daily_reports_all_fields_required_v77;
ALTER TABLE public.staff_daily_reports
  DROP CONSTRAINT IF EXISTS staff_daily_reports_completed_work_v84;
ALTER TABLE public.staff_daily_reports
  ADD CONSTRAINT staff_daily_reports_completed_work_v84
  CHECK (CHAR_LENGTH(BTRIM(completed_work)) BETWEEN 1 AND 1000) NOT VALID;

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
    RAISE EXCEPTION 'employee daily reports cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.staff_account_id IS DISTINCT FROM OLD.staff_account_id
    OR NEW.report_date IS DISTINCT FROM OLD.report_date OR OLD.report_date IS DISTINCT FROM shanghai_today) THEN
    RAISE EXCEPTION 'historical employee daily reports are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.report_date IS DISTINCT FROM shanghai_today THEN
    RAISE EXCEPTION 'employee daily reports may only be written for the current Shanghai date' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.staff_accounts AS account
    JOIN public.teachers AS teacher ON teacher.staff_account_id = account.id
    WHERE account.id = NEW.staff_account_id AND account.role_code = 'teacher'
      AND account.account_status = 'ACTIVE' AND teacher.teacher_status = 'ACTIVE'
  ) INTO valid_teacher;
  IF NOT valid_teacher THEN
    RAISE EXCEPTION 'daily reports are restricted to active teacher accounts' USING ERRCODE = '23514';
  END IF;
  NEW.completed_work := BTRIM(COALESCE(NEW.completed_work, ''));
  NEW.customer_project_progress := '';
  NEW.problems_and_support := '';
  NEW.tomorrow_plan := '';
  IF CHAR_LENGTH(NEW.completed_work) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'daily report completed work is required and limited to 1000 characters'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_staff_daily_report_today_v73() IS
  'Migrations 073/084: Shanghai-today-only teacher daily reports, immutable history, and one required UTF-8 completed-work field limited to 1000 characters.';
COMMENT ON CONSTRAINT staff_daily_reports_completed_work_v84 ON public.staff_daily_reports IS
  'Migration 084: only completed_work is writable and required for future reports; up to 1000 UTF-8 characters including emoji.';

COMMIT;

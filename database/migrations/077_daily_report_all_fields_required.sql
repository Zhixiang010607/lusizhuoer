-- Migration 077: require all four teacher daily-report fields on every new
-- or same-day updated report. Historical rows are preserved without fabricated
-- text; the NOT VALID constraint still protects all future writes.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.staff_daily_reports') IS NULL THEN
    RAISE EXCEPTION 'migration 077 requires public.staff_daily_reports';
  END IF;
END;
$$;

ALTER TABLE public.staff_daily_reports
  DROP CONSTRAINT IF EXISTS staff_daily_reports_all_fields_required_v77;
ALTER TABLE public.staff_daily_reports
  ADD CONSTRAINT staff_daily_reports_all_fields_required_v77
  CHECK (
    CHAR_LENGTH(BTRIM(completed_work)) BETWEEN 1 AND 200
    AND CHAR_LENGTH(BTRIM(customer_project_progress)) BETWEEN 1 AND 200
    AND CHAR_LENGTH(BTRIM(problems_and_support)) BETWEEN 1 AND 200
    AND CHAR_LENGTH(BTRIM(tomorrow_plan)) BETWEEN 1 AND 200
  ) NOT VALID;

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
  NEW.customer_project_progress := BTRIM(COALESCE(NEW.customer_project_progress, ''));
  NEW.problems_and_support := BTRIM(COALESCE(NEW.problems_and_support, ''));
  NEW.tomorrow_plan := BTRIM(COALESCE(NEW.tomorrow_plan, ''));
  IF CHAR_LENGTH(NEW.completed_work) NOT BETWEEN 1 AND 200
    OR CHAR_LENGTH(NEW.customer_project_progress) NOT BETWEEN 1 AND 200
    OR CHAR_LENGTH(NEW.problems_and_support) NOT BETWEEN 1 AND 200
    OR CHAR_LENGTH(NEW.tomorrow_plan) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'all four daily report fields are required and limited to 200 characters'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_staff_daily_report_today_v73() IS
  'Migrations 073/076/077: Shanghai-today-only teacher daily reports, immutable history, four required fields and a 200-character limit per field.';
COMMENT ON CONSTRAINT staff_daily_reports_all_fields_required_v77 ON public.staff_daily_reports IS
  'Migration 077: all four fields are required for future daily-report writes; historical blank rows remain unchanged.';

COMMIT;

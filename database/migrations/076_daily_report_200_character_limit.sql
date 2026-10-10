-- Migration 076: enforce the final 200-character limit for every daily-report field.
-- Existing historical text is preserved; every new or same-day updated value
-- is rejected by the database trigger when it exceeds 200 characters.

BEGIN;

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
  NEW.completed_work := BTRIM(NEW.completed_work);
  NEW.customer_project_progress := BTRIM(COALESCE(NEW.customer_project_progress, ''));
  NEW.problems_and_support := BTRIM(COALESCE(NEW.problems_and_support, ''));
  NEW.tomorrow_plan := BTRIM(COALESCE(NEW.tomorrow_plan, ''));
  IF CHAR_LENGTH(NEW.completed_work) NOT BETWEEN 1 AND 200
    OR CHAR_LENGTH(NEW.customer_project_progress) > 200
    OR CHAR_LENGTH(NEW.problems_and_support) > 200
    OR CHAR_LENGTH(NEW.tomorrow_plan) > 200 THEN
    RAISE EXCEPTION 'daily report fields may not exceed 200 characters' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_staff_daily_report_today_v73() IS
  'Migrations 073/076: Shanghai-today-only teacher daily reports, immutable history and a 200-character limit per field.';

COMMIT;

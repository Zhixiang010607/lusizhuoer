-- CloudBase migration 050, part 3 / 7. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.sync_teacher_account_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  desired_status TEXT;
BEGIN
  IF NEW.staff_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  desired_status := CASE WHEN NEW.teacher_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;
  UPDATE public.staff_accounts AS account
     SET account_status = desired_status,
         updated_at = NOW()
   WHERE account.id = NEW.staff_account_id
     AND account.account_status IS DISTINCT FROM desired_status;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_teacher_profile ON public.staff_accounts;
CREATE TRIGGER trg_sync_teacher_profile
AFTER INSERT OR UPDATE OF staff_name, account_status, role_code ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_profile();

DROP TRIGGER IF EXISTS trg_sync_teacher_account_status ON public.teachers;
CREATE TRIGGER trg_sync_teacher_account_status
AFTER INSERT OR UPDATE OF teacher_status, staff_account_id ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_account_status();

COMMIT;

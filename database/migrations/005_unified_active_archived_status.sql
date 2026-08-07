-- All master data uses only the ACTIVE and ARCHIVED business states.
-- CloudBase authentication BLOCKED is an authentication-layer flag, not a business status value.
UPDATE public.staff_accounts SET account_status = 'ARCHIVED' WHERE account_status = 'BLOCKED';

ALTER TABLE public.staff_accounts
  DROP CONSTRAINT IF EXISTS staff_accounts_account_status_check;
ALTER TABLE public.staff_accounts
  ADD CONSTRAINT staff_accounts_account_status_check
  CHECK (account_status IN ('ACTIVE', 'ARCHIVED'));

-- When a teacher record is archived, archive its linked login account. Restore the account when the teacher becomes active.
CREATE OR REPLACE FUNCTION public.sync_teacher_account_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.staff_account_id IS NOT NULL THEN
    UPDATE public.staff_accounts
    SET account_status = CASE WHEN NEW.teacher_status = 'ARCHIVED' THEN 'ARCHIVED' ELSE 'ACTIVE' END,
        updated_at = NOW()
    WHERE id = NEW.staff_account_id
      AND account_status IS DISTINCT FROM CASE WHEN NEW.teacher_status = 'ARCHIVED' THEN 'ARCHIVED' ELSE 'ACTIVE' END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_teacher_account_status ON public.teachers;
CREATE TRIGGER trg_sync_teacher_account_status
AFTER INSERT OR UPDATE OF teacher_status, staff_account_id ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_account_status();

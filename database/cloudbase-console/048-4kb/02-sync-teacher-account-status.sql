-- 048 fallback, 02/15. Run only after file 01 committed.
BEGIN;
CREATE OR REPLACE FUNCTION public.sync_teacher_account_status()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE desired_status TEXT;
BEGIN
  IF NEW.staff_account_id IS NULL THEN RETURN NEW; END IF;
  desired_status := CASE WHEN NEW.teacher_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;
  UPDATE public.staff_accounts
     SET account_status = desired_status,
         updated_at = NOW()
   WHERE id = NEW.staff_account_id
     AND account_status IS DISTINCT FROM desired_status;
  RETURN NEW;
END;
$$;
COMMIT;

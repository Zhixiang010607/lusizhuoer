-- CloudBase migration 046, part 2 / 8. Run this file by itself.
BEGIN;
-- Ensure every teacher login account owns one actual teacher master row on
-- both rebuilt and incremental databases.  This is intentionally compatible
-- with the old identity-link triggers and preserves existing teacher IDs.
CREATE OR REPLACE FUNCTION public.sync_teacher_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  desired_status TEXT;
BEGIN
  IF NEW.role_code <> 'teacher' THEN
    RETURN NEW;
  END IF;

  desired_status := CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;

  INSERT INTO public.teachers
    (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
  VALUES
    ('TCHF' || NEW.id::TEXT, NEW.staff_name, NEW.id, desired_status, 'PENDING')
  ON CONFLICT (staff_account_id) DO UPDATE
    SET teacher_name = EXCLUDED.teacher_name,
        teacher_status = CASE
          WHEN public.teachers.face_enrollment_status = 'ENROLLED'
            THEN EXCLUDED.teacher_status
          ELSE 'ARCHIVED'
        END,
        updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_teacher_profile ON public.staff_accounts;
CREATE TRIGGER trg_sync_teacher_profile
AFTER INSERT OR UPDATE OF staff_name, account_status, role_code ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_profile();

-- A teacher may be active only after the explicit face-enrollment transaction
-- has completed.  Status changes in either direction keep the login account
-- and identity link in sync without deleting historical business records.
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
  desired_status := CASE
    WHEN NEW.teacher_status = 'ACTIVE'
      AND NEW.face_enrollment_status = 'ENROLLED'
      AND BTRIM(COALESCE(NEW.face_person_id, '')) <> ''
      THEN 'ACTIVE'
    ELSE 'ARCHIVED'
  END;
  UPDATE public.staff_accounts
     SET account_status = desired_status,
         updated_at = NOW()
   WHERE id = NEW.staff_account_id
     AND account_status IS DISTINCT FROM desired_status;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_teacher_account_status ON public.teachers;
CREATE TRIGGER trg_sync_teacher_account_status
AFTER INSERT OR UPDATE OF teacher_status, staff_account_id, face_enrollment_status, face_person_id
ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_account_status();

-- Backfill the missing teacher profiles before the quota foreign keys and
-- face-enrollment actions use them.  Accounts remain archived until a face is
-- enrolled, preventing a profile-created but incomplete teacher from logging
-- in or appearing in business selection lists.
INSERT INTO public.teachers
  (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
SELECT 'TCHF' || account.id::TEXT, account.staff_name, account.id, 'ARCHIVED', 'PENDING'
  FROM public.staff_accounts AS account
 WHERE account.role_code = 'teacher'
   AND NOT EXISTS (
     SELECT 1 FROM public.teachers AS teacher
      WHERE teacher.staff_account_id = account.id
   );

UPDATE public.teachers
   SET teacher_status = 'ARCHIVED'
 WHERE teacher_status = 'ACTIVE'
   AND face_enrollment_status <> 'ENROLLED';

COMMIT;

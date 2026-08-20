-- 048 fallback, 01/15. Run only after ../048-01-quota-lifecycle-schema.sql committed.
BEGIN;
CREATE OR REPLACE FUNCTION public.sync_teacher_profile()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE desired_status TEXT;
BEGIN
  IF NEW.role_code <> 'teacher' THEN RETURN NEW; END IF;
  desired_status := CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;
  INSERT INTO public.teachers
    (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
  VALUES
    ('TCHF' || NEW.id::TEXT, NEW.staff_name, NEW.id, desired_status, 'PENDING')
  ON CONFLICT (staff_account_id) DO UPDATE
    SET teacher_name = EXCLUDED.teacher_name,
        teacher_status = EXCLUDED.teacher_status,
        updated_at = NOW();
  RETURN NEW;
END;
$$;
COMMIT;

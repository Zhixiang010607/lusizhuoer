-- CloudBase migration 050, part 4 / 7. Run this file by itself.
BEGIN;
-- One idempotent statement repairs both a missing row and a stale name/status.
-- PENDING is only an initial face attribute; it does not archive an account.
INSERT INTO public.teachers
  (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
SELECT 'TCHF' || account.id::TEXT,
       account.staff_name,
       account.id,
       CASE WHEN account.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END,
       'PENDING'
  FROM public.staff_accounts AS account
 WHERE account.role_code = 'teacher'
ON CONFLICT (staff_account_id) DO UPDATE
  SET teacher_name = EXCLUDED.teacher_name,
      teacher_status = EXCLUDED.teacher_status,
      updated_at = NOW();

COMMIT;

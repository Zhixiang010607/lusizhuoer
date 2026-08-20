-- CloudBase migration 051, part 1 / 10. Run this file by itself.
BEGIN;
DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGCLASS('public.teachers') IS NULL
     OR TO_REGPROCEDURE('public.sync_teacher_profile()') IS NULL
     OR TO_REGPROCEDURE('public.sync_teacher_account_status()') IS NULL THEN
    RAISE EXCEPTION 'teacher face operation prerequisites are missing; execute migrations through 050 first';
  END IF;
END;
$$;

COMMIT;

-- Migration 050 read-only verification. This file changes no data.
WITH definitions AS (
  SELECT COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE('public.sync_teacher_profile()')), '') AS profile_fn,
         COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE('public.sync_teacher_account_status()')), '') AS status_fn,
         COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE('public.delete_teacher_product_experience_quota(bigint,bigint,bigint)')), '') AS delete_fn,
         COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE('public.recharge_teacher_product_experience_quota(bigint,bigint,integer,text,character varying,bigint)')), '') AS recharge_fn
)
SELECT requirement, kind, object_name,
       CASE WHEN ready THEN 'READY' ELSE 'MISSING' END AS status
FROM (
  VALUES
    ('050', 'data', 'teacher accounts missing teacher master',
      NOT EXISTS (
        SELECT 1 FROM public.staff_accounts account
         WHERE account.role_code = 'teacher'
           AND NOT EXISTS (SELECT 1 FROM public.teachers teacher WHERE teacher.staff_account_id = account.id)
      )),
    ('050', 'data', 'teacher/account status parity',
      NOT EXISTS (
        SELECT 1 FROM public.staff_accounts account
        JOIN public.teachers teacher ON teacher.staff_account_id = account.id
        WHERE account.role_code = 'teacher'
          AND teacher.teacher_status IS DISTINCT FROM
              CASE WHEN account.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
      )),
    ('050', 'trigger', 'public.trg_sync_teacher_profile',
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.staff_accounts'::regclass
              AND tgname = 'trg_sync_teacher_profile' AND NOT tgisinternal)),
    ('050', 'trigger', 'public.trg_sync_teacher_account_status',
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.teachers'::regclass
              AND tgname = 'trg_sync_teacher_account_status' AND NOT tgisinternal)),
    ('050', 'function', 'optional-face teacher status sync',
      (SELECT profile_fn ~* 'teacher_status[[:space:]]*=[[:space:]]*excluded[.]teacher_status'
              AND status_fn !~* 'face_enrollment_status|face_person_id' FROM definitions)),
    ('050', 'function', 'delete active master-data gate',
      (SELECT POSITION('assert_active_teacher_experience_subjects' IN delete_fn) > 0 FROM definitions)),
    ('050', 'function', 'qualified teacher quota recharge',
      (SELECT recharge_fn ~* '[a-z_]+[.]manual_recharge_count[[:space:]]*[+][[:space:]]*p_unit_count'
              AND recharge_fn ~* '[a-z_]+[.]available_count[[:space:]]*[+][[:space:]]*p_unit_count'
         FROM definitions))
) AS checks(requirement, kind, object_name, ready)
ORDER BY kind, object_name;

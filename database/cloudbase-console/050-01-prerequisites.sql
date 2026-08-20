-- CloudBase migration 050, part 1 / 7. Run this file by itself.
BEGIN;
DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGCLASS('public.teachers') IS NULL
     OR TO_REGCLASS('public.teacher_product_experience_quotas') IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_recharges') IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_configuration_events') IS NULL
     OR TO_REGPROCEDURE('public.assert_active_teacher_experience_subjects(bigint,bigint)') IS NULL
     OR TO_REGPROCEDURE('public.assert_teacher_experience_quota_actor(bigint)') IS NULL
     OR TO_REGPROCEDURE('public.validate_teacher_experience_quota_recharge(integer,text,character varying)') IS NULL
     OR TO_REGPROCEDURE('public.reset_teacher_experience_quota(bigint,date,bigint)') IS NULL THEN
    RAISE EXCEPTION 'teacher profile/quota prerequisites are missing; execute migrations through 049 first';
  END IF;
END;
$$;

LOCK TABLE public.staff_accounts, public.teachers,
           public.teacher_product_experience_quotas,
           public.teacher_experience_quota_recharges
  IN SHARE ROW EXCLUSIVE MODE;

COMMIT;

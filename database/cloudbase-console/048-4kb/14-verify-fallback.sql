-- 048 fallback, 15/15. Read-only verification after files 01 through 14 committed.
BEGIN;
WITH requirements(kind, object_name, is_ready) AS (
  VALUES
    ('table', 'public.teacher_experience_quota_configuration_events',
      TO_REGCLASS('public.teacher_experience_quota_configuration_events') IS NOT NULL),
    ('function', 'public.sync_teacher_profile()',
      TO_REGPROCEDURE('public.sync_teacher_profile()') IS NOT NULL),
    ('function', 'public.sync_teacher_account_status()',
      TO_REGPROCEDURE('public.sync_teacher_account_status()') IS NOT NULL),
    ('function', 'public.assert_active_teacher_experience_subjects(bigint,bigint)',
      TO_REGPROCEDURE('public.assert_active_teacher_experience_subjects(bigint,bigint)') IS NOT NULL),
    ('function', 'public.teacher_experience_quota_is_resettable(bigint)',
      TO_REGPROCEDURE('public.teacher_experience_quota_is_resettable(bigint)') IS NOT NULL),
    ('function', 'public.reset_teacher_experience_quota(bigint,date,bigint)',
      TO_REGPROCEDURE('public.reset_teacher_experience_quota(bigint,date,bigint)') IS NOT NULL),
    ('function', 'public.reset_teacher_experience_quotas(date,bigint)',
      TO_REGPROCEDURE('public.reset_teacher_experience_quotas(date,bigint)') IS NOT NULL),
    ('function', 'public.upsert_teacher_product_experience_quota(bigint,bigint,integer,bigint)',
      TO_REGPROCEDURE('public.upsert_teacher_product_experience_quota(bigint,bigint,integer,bigint)') IS NOT NULL),
    ('function', 'public.delete_teacher_product_experience_quota(bigint,bigint,bigint)',
      TO_REGPROCEDURE('public.delete_teacher_product_experience_quota(bigint,bigint,bigint)') IS NOT NULL),
    ('function', 'public.validate_teacher_experience_quota_recharge(integer,text,character varying)',
      TO_REGPROCEDURE('public.validate_teacher_experience_quota_recharge(integer,text,character varying)') IS NOT NULL),
    ('function', 'public.recharge_teacher_product_experience_quota(bigint,bigint,integer,text,character varying,bigint)',
      TO_REGPROCEDURE('public.recharge_teacher_product_experience_quota(bigint,bigint,integer,text,character varying,bigint)') IS NOT NULL),
    ('function', 'public.assert_active_order_master_data()',
      TO_REGPROCEDURE('public.assert_active_order_master_data()') IS NOT NULL),
    ('function', 'public.lock_active_verification_subjects(bigint,bigint,bigint,bigint,bigint)',
      TO_REGPROCEDURE('public.lock_active_verification_subjects(bigint,bigint,bigint,bigint,bigint)') IS NOT NULL),
    ('function', 'public.assert_active_teacher_experience_quota_usage()',
      TO_REGPROCEDURE('public.assert_active_teacher_experience_quota_usage()') IS NOT NULL),
    ('trigger', 'public.trg_assert_active_teacher_experience_quota_usage',
      EXISTS (SELECT 1 FROM pg_trigger trigger_row
               WHERE trigger_row.tgrelid = 'public.teacher_experience_quota_usages'::REGCLASS
                 AND trigger_row.tgname = 'trg_assert_active_teacher_experience_quota_usage'
                 AND NOT trigger_row.tgisinternal))
)
SELECT kind, object_name, CASE WHEN is_ready THEN 'READY' ELSE 'MISSING' END AS status
  FROM requirements
 ORDER BY kind, object_name;
COMMIT;

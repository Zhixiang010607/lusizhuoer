SELECT 'supplement_create_function' AS item,
       CASE WHEN TO_REGPROCEDURE(
         'public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)'
       ) IS NOT NULL THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'supplement_pending_integrity',
       CASE WHEN POSITION('CURRENT_VERIFICATION_INTEGRITY_V79' IN PG_GET_FUNCTIONDEF(
         TO_REGPROCEDURE('public.enforce_current_verification_integrity()')
       )) > 0 AND POSITION('SUPPLEMENT' IN PG_GET_FUNCTIONDEF(
         TO_REGPROCEDURE('public.enforce_current_verification_integrity()')
       )) > 0 THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'supplement_teacher_matrix',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = TO_REGCLASS('public.verification_records')
            AND tgname = 'trg_079_verification_business_teacher'
            AND NOT tgisinternal
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'approval_balance_guard',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = TO_REGCLASS('public.verification_records')
            AND tgname = 'trg_063_paid_verification_balance'
            AND NOT tgisinternal
       ) AND POSITION('SUPPLEMENT' IN PG_GET_FUNCTIONDEF(
         TO_REGPROCEDURE('public.enforce_paid_verification_available_balance_v63()')
       )) > 0 THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'supplement_no_device_signal',
       CASE WHEN POSITION('device_signal_outbox' IN PG_GET_FUNCTIONDEF(
         TO_REGPROCEDURE('public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)')
       )) = 0 THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'supplement_service_role_only',
       CASE WHEN HAS_FUNCTION_PRIVILEGE(
         'service_role',
         'public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)',
         'EXECUTE'
       ) AND NOT HAS_FUNCTION_PRIVILEGE(
         'authenticated',
         'public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)',
         'EXECUTE'
       ) THEN 'READY' ELSE 'MISSING' END;

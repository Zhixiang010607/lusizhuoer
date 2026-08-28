-- Read-only verification for migration 065. Every row must report
-- record_count=0 and status=READY.
WITH columns_ready AS (
  SELECT COUNT(*) AS total_count,
         COUNT(*) FILTER (WHERE is_nullable <> 'YES') AS bad_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND (table_name, column_name) IN (
       ('recharge_records', 'teacher_id'),
       ('verification_records', 'teacher_id'),
       ('device_signal_outbox', 'teacher_id')
     )
), functions_ready AS (
  SELECT
    COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
      'public.enforce_business_teacher_matrix_v65()'
    )), '') AS matrix_body,
    COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
      'public.lock_active_verification_subjects(bigint,bigint,bigint,bigint,bigint)'
    )), '') AS lock_body,
    COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
      'public.assert_matching_verification_idempotency(bigint,character varying,bigint,bigint,bigint,bigint,bigint,text,text,character varying,character varying)'
    )), '') AS idempotency_body,
    COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
      'public.validate_retail_product_purchase_insert()'
    )), '') AS retail_body
)
SELECT 'optional teacher columns' AS check_name,
       (3 - total_count) + bad_count AS record_count,
       CASE WHEN total_count = 3 AND bad_count = 0 THEN 'READY' ELSE 'CHECK' END AS status
  FROM columns_ready
UNION ALL
SELECT 'legacy required constraints retired',
       COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
  FROM pg_constraint
 WHERE conname IN (
   'recharge_records_teacher_required',
   'verification_records_teacher_required'
 )
UNION ALL
SELECT 'v65 business teacher triggers',
       CASE WHEN COUNT(*) = 2 AND BOOL_AND(tgenabled <> 'D') THEN 0 ELSE 1 END,
       CASE WHEN COUNT(*) = 2 AND BOOL_AND(tgenabled <> 'D') THEN 'READY' ELSE 'CHECK' END
  FROM pg_trigger
 WHERE tgname IN (
   'trg_065_recharge_business_teacher',
   'trg_065_verification_business_teacher'
 )
UNION ALL
SELECT 'legacy v59 triggers retired',
       COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
  FROM pg_trigger
 WHERE tgname IN (
   'trg_059_recharge_business_teacher',
   'trg_059_verification_business_teacher'
 )
UNION ALL
SELECT 'store teacher optional matrix',
       CASE WHEN POSITION('STORE_BUSINESS_TEACHER_OPTIONAL_V65' IN matrix_body) > 0
                  AND POSITION('TEACHER_SELF_ATTRIBUTION_V65' IN matrix_body) > 0
                  AND POSITION('STORE_EXPERIENCE_DENIED_V65' IN matrix_body) > 0
            THEN 0 ELSE 1 END,
       CASE WHEN POSITION('STORE_BUSINESS_TEACHER_OPTIONAL_V65' IN matrix_body) > 0
                  AND POSITION('TEACHER_SELF_ATTRIBUTION_V65' IN matrix_body) > 0
                  AND POSITION('STORE_EXPERIENCE_DENIED_V65' IN matrix_body) > 0
            THEN 'READY' ELSE 'CHECK' END
  FROM functions_ready
UNION ALL
SELECT 'verification optional teacher lock',
       CASE WHEN POSITION('OPTIONAL_VERIFICATION_TEACHER_V65' IN lock_body) > 0
                  AND POSITION('IF p_teacher_id IS NOT NULL' IN lock_body) > 0
            THEN 0 ELSE 1 END,
       CASE WHEN POSITION('OPTIONAL_VERIFICATION_TEACHER_V65' IN lock_body) > 0
                  AND POSITION('IF p_teacher_id IS NOT NULL' IN lock_body) > 0
            THEN 'READY' ELSE 'CHECK' END
  FROM functions_ready
UNION ALL
SELECT 'null safe verification idempotency',
       CASE WHEN POSITION('NULL_SAFE_TEACHER_IDEMPOTENCY_V65' IN idempotency_body) > 0
                  AND POSITION('IS NOT DISTINCT FROM p_teacher_id' IN idempotency_body) > 0
            THEN 0 ELSE 1 END,
       CASE WHEN POSITION('NULL_SAFE_TEACHER_IDEMPOTENCY_V65' IN idempotency_body) > 0
                  AND POSITION('IS NOT DISTINCT FROM p_teacher_id' IN idempotency_body) > 0
            THEN 'READY' ELSE 'CHECK' END
  FROM functions_ready
UNION ALL
SELECT 'retail purchase optional teacher',
       CASE WHEN POSITION('STORE_RETAIL_PRODUCT_TEACHER_OPTIONAL_V65' IN retail_body) > 0
                  AND POSITION('ELSIF NEW.teacher_id IS NOT NULL' IN retail_body) > 0
            THEN 0 ELSE 1 END,
       CASE WHEN POSITION('STORE_RETAIL_PRODUCT_TEACHER_OPTIONAL_V65' IN retail_body) > 0
                  AND POSITION('ELSIF NEW.teacher_id IS NOT NULL' IN retail_body) > 0
            THEN 'READY' ELSE 'CHECK' END
  FROM functions_ready
UNION ALL
SELECT 'client execution remains closed',
       (CASE WHEN HAS_FUNCTION_PRIVILEGE('anon',
          'public.enforce_business_teacher_matrix_v65()', 'EXECUTE') THEN 1 ELSE 0 END
        + CASE WHEN HAS_FUNCTION_PRIVILEGE('authenticated',
          'public.enforce_business_teacher_matrix_v65()', 'EXECUTE') THEN 1 ELSE 0 END
        + CASE WHEN HAS_FUNCTION_PRIVILEGE('anon',
          'public.validate_retail_product_purchase_insert()', 'EXECUTE') THEN 1 ELSE 0 END
        + CASE WHEN HAS_FUNCTION_PRIVILEGE('authenticated',
          'public.validate_retail_product_purchase_insert()', 'EXECUTE') THEN 1 ELSE 0 END),
       CASE WHEN NOT HAS_FUNCTION_PRIVILEGE('anon',
                    'public.enforce_business_teacher_matrix_v65()', 'EXECUTE')
                  AND NOT HAS_FUNCTION_PRIVILEGE('authenticated',
                    'public.enforce_business_teacher_matrix_v65()', 'EXECUTE')
                  AND NOT HAS_FUNCTION_PRIVILEGE('anon',
                    'public.validate_retail_product_purchase_insert()', 'EXECUTE')
                  AND NOT HAS_FUNCTION_PRIVILEGE('authenticated',
                    'public.validate_retail_product_purchase_insert()', 'EXECUTE')
                  AND HAS_FUNCTION_PRIVILEGE('service_role',
                    'public.enforce_business_teacher_matrix_v65()', 'EXECUTE')
                  AND HAS_FUNCTION_PRIVILEGE('service_role',
                    'public.validate_retail_product_purchase_insert()', 'EXECUTE')
            THEN 'READY' ELSE 'CHECK' END;

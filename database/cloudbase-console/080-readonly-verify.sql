-- Migration 080 read-only verification. Expected: both rows are READY.

WITH function_source AS (
  SELECT pg_get_functiondef(
    'public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)'::regprocedure
  ) AS source
)
SELECT 'supplement_qualified_identifiers' AS check_name,
       CASE WHEN source LIKE '%store.id = p_store_id%'
                  AND source LIKE '%product.id = p_product_id%'
                  AND source LIKE '%submitter.id = p_submitted_by_account_id%'
                  AND source NOT LIKE '%WHERE id = p_store_id%'
                  AND source NOT LIKE '%WHERE id = p_product_id%'
                  AND source NOT LIKE '%WHERE id = p_submitted_by_account_id%'
            THEN 'READY' ELSE 'BLOCKED' END AS status
  FROM function_source
UNION ALL
SELECT 'supplement_service_role_only' AS check_name,
       CASE WHEN has_function_privilege(
                    'service_role',
                    'public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)',
                    'EXECUTE'
                  )
                  AND NOT has_function_privilege(
                    'anon',
                    'public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)',
                    'EXECUTE'
                  )
                  AND NOT has_function_privilege(
                    'authenticated',
                    'public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)',
                    'EXECUTE'
                  )
            THEN 'READY' ELSE 'BLOCKED' END AS status;

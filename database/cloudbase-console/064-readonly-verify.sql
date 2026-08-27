-- Read-only verification for migration 064. Every row must report READY.
SELECT 'verification unit constraint' AS check_name,
       COUNT(*) FILTER (
         WHERE PG_GET_CONSTRAINTDEF(oid) NOT ILIKE '%BETWEEN 1 AND 999%'
       ) AS record_count,
       CASE WHEN COUNT(*) = 1 AND BOOL_AND(PG_GET_CONSTRAINTDEF(oid) ILIKE '%BETWEEN 1 AND 999%')
            THEN 'READY' ELSE 'CHECK' END AS status
  FROM pg_constraint
 WHERE conrelid = 'public.verification_records'::regclass
   AND conname = 'verification_records_unit_count_check'
UNION ALL
SELECT 'experience usage unit constraint',
       COUNT(*) FILTER (
         WHERE PG_GET_CONSTRAINTDEF(oid) NOT ILIKE '%BETWEEN 1 AND 999%'
       ),
       CASE WHEN COUNT(*) = 1 AND BOOL_AND(PG_GET_CONSTRAINTDEF(oid) ILIKE '%BETWEEN 1 AND 999%')
            THEN 'READY' ELSE 'CHECK' END
  FROM pg_constraint
 WHERE conrelid = 'public.teacher_experience_quota_usages'::regclass
   AND conname = 'teacher_experience_quota_usages_unit_count_check'
UNION ALL
SELECT 'variable verification writer',
       CASE WHEN TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)'
       ) IS NULL THEN 1 ELSE 0 END,
       CASE WHEN TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)'
       ) IS NOT NULL
       AND POSITION('quota_row.available_count - p_unit_count' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)'
       ))) > 0
       AND POSITION('device_signal_outbox' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)'
       ))) > 0 THEN 'READY' ELSE 'CHECK' END
UNION ALL
SELECT 'variable experience writer',
       CASE WHEN TO_REGPROCEDURE(
         'public.create_experience_verification_with_customer_face_photo(bigint,bigint,bigint,bigint,integer,bigint,text,character varying,character varying,character varying)'
       ) IS NULL THEN 1 ELSE 0 END,
       CASE WHEN TO_REGPROCEDURE(
         'public.create_experience_verification_with_customer_face_photo(bigint,bigint,bigint,bigint,integer,bigint,text,character varying,character varying,character varying)'
       ) IS NOT NULL
       AND POSITION('p_product_id, p_unit_count' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_experience_verification_with_customer_face_photo(bigint,bigint,bigint,bigint,integer,bigint,text,character varying,character varying,character varying)'
       ))) > 0 THEN 'READY' ELSE 'CHECK' END
UNION ALL
SELECT 'legacy fixed-one writers blocked',
       CASE WHEN POSITION('unit count is required by migration 064' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
       ))) > 0
       AND POSITION('unit count is required by migration 064' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_experience_verification_with_customer_face_photo(bigint,bigint,bigint,bigint,bigint,text,character varying,character varying,character varying)'
       ))) > 0 THEN 0 ELSE 1 END,
       CASE WHEN POSITION('unit count is required by migration 064' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
       ))) > 0
       AND POSITION('unit count is required by migration 064' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_experience_verification_with_customer_face_photo(bigint,bigint,bigint,bigint,bigint,text,character varying,character varying,character varying)'
       ))) > 0 THEN 'READY' ELSE 'CHECK' END
UNION ALL
SELECT 'client execution remains closed',
       (CASE WHEN HAS_FUNCTION_PRIVILEGE('anon',
          'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)', 'EXECUTE') THEN 1 ELSE 0 END
        + CASE WHEN HAS_FUNCTION_PRIVILEGE('authenticated',
          'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)', 'EXECUTE') THEN 1 ELSE 0 END),
       CASE WHEN NOT HAS_FUNCTION_PRIVILEGE('anon',
          'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)', 'EXECUTE')
        AND NOT HAS_FUNCTION_PRIVILEGE('authenticated',
          'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)', 'EXECUTE')
        AND HAS_FUNCTION_PRIVILEGE('service_role',
          'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,integer,character varying,bigint,text,text,character varying,character varying,character varying)', 'EXECUTE')
       THEN 'READY' ELSE 'CHECK' END
UNION ALL
SELECT 'stored unit counts valid',
       (SELECT COUNT(*) FROM public.verification_records WHERE unit_count NOT BETWEEN 1 AND 999)
       + (SELECT COUNT(*) FROM public.teacher_experience_quota_usages WHERE unit_count NOT BETWEEN 1 AND 999),
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.verification_records WHERE unit_count NOT BETWEEN 1 AND 999)
              AND NOT EXISTS (SELECT 1 FROM public.teacher_experience_quota_usages WHERE unit_count NOT BETWEEN 1 AND 999)
            THEN 'READY' ELSE 'CHECK' END
UNION ALL
SELECT 'experience usage matches verification',
       COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
  FROM public.teacher_experience_quota_usages AS usage
  JOIN public.verification_records AS verification
    ON verification.id = usage.verification_id
 WHERE verification.verification_type <> 'EXPERIENCE'
    OR verification.unit_count <> usage.unit_count;

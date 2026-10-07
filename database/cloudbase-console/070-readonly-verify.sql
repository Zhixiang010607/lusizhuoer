SELECT
  '070 rating form version column' AS check_name,
  CASE WHEN EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'verification_customer_ratings'
       AND column_name = 'rating_form_version'
       AND is_nullable = 'NO'
       AND column_default LIKE '2%'
  ) THEN 'READY' ELSE 'NOT_READY' END AS status

UNION ALL

SELECT
  '070 v2 score constraint' AS check_name,
  CASE WHEN EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.verification_customer_ratings'::regclass
       AND conname = 'ck_verification_customer_ratings_submission'
       AND PG_GET_CONSTRAINTDEF(oid) LIKE '%rating_form_version = 1%'
       AND PG_GET_CONSTRAINTDEF(oid) LIKE '%teacher_service_score IS NOT NULL%'
  ) THEN 'READY' ELSE 'NOT_READY' END AS status

UNION ALL

SELECT
  '070 form version constraint' AS check_name,
  CASE WHEN EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.verification_customer_ratings'::regclass
       AND conname = 'ck_verification_customer_ratings_form_version'
       AND PG_GET_CONSTRAINTDEF(oid) LIKE '%rating_form_version%'
  ) THEN 'READY' ELSE 'NOT_READY' END AS status

UNION ALL

SELECT
  '070 current row compatibility' AS check_name,
  CASE WHEN NOT EXISTS (
    SELECT 1
      FROM public.verification_customer_ratings
     WHERE rating_form_version IS NULL
        OR rating_form_version NOT IN (1, 2)
        OR (
          rating_status = 'SUBMITTED'
          AND (
            store_environment_score IS NULL
            OR overall_experience_score IS NULL
            OR (
              teacher_service_score IS NULL
              AND NOT (rating_form_version = 1 AND teacher_id IS NULL)
            )
            OR submitted_at IS NULL
          )
        )
        OR (
          rating_status = 'OPEN'
          AND (
            store_environment_score IS NOT NULL
            OR teacher_service_score IS NOT NULL
            OR overall_experience_score IS NOT NULL
            OR customer_comment IS NOT NULL
            OR submitted_at IS NOT NULL
          )
        )
  ) THEN 'READY' ELSE 'NOT_READY' END AS status

UNION ALL

SELECT
  '070 v2 default' AS check_name,
  CASE WHEN (
    SELECT column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'verification_customer_ratings'
       AND column_name = 'rating_form_version'
  ) LIKE '2%' THEN 'READY' ELSE 'NOT_READY' END AS status;

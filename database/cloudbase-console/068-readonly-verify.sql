SELECT 'rating table present' AS check_name,
       COUNT(*) AS record_count,
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END AS status
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'verification_customer_ratings'
UNION ALL
SELECT 'rating table has RLS', COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'verification_customer_ratings'
  AND c.relrowsecurity
UNION ALL
SELECT 'one rating per verification', COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
FROM pg_constraint
WHERE conrelid = 'public.verification_customer_ratings'::regclass
  AND conname = 'uq_verification_customer_ratings_verification'
UNION ALL
SELECT 'plaintext rating token absent', COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'verification_customer_ratings'
  AND column_name IN ('token', 'public_token', 'rating_token')
UNION ALL
SELECT 'work-order binding trigger present', COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
FROM pg_trigger
WHERE tgrelid = 'public.verification_customer_ratings'::regclass
  AND tgname = 'trg_enforce_verification_customer_rating_binding'
  AND NOT tgisinternal
UNION ALL
SELECT 'rating delete guard present', COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
FROM pg_trigger
WHERE tgrelid = 'public.verification_customer_ratings'::regclass
  AND tgname = 'trg_prevent_verification_customer_rating_delete'
  AND NOT tgisinternal
UNION ALL
SELECT 'token version present', COUNT(*),
       CASE WHEN COUNT(*) = 1 THEN 'READY' ELSE 'CHECK' END
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'verification_customer_ratings'
  AND column_name = 'token_version'
UNION ALL
SELECT 'client table access closed', COUNT(*),
       CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'UNSAFE' END
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'verification_customer_ratings'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
UNION ALL
SELECT 'service role rating CRUD retained', COUNT(DISTINCT privilege_type),
       CASE WHEN COUNT(DISTINCT privilege_type) = 4 THEN 'READY' ELSE 'CHECK' END
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'verification_customer_ratings'
  AND grantee = 'service_role'
  AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE');

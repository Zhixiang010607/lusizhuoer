SELECT 'staff phone unique constraint' AS check_name,
       COUNT(*)::bigint AS observed_count
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname = 'staff_accounts'
  AND c.contype = 'u' AND pg_get_constraintdef(c.oid) = 'UNIQUE (phone)'
UNION ALL
SELECT 'duplicate staff phones', COUNT(*)::bigint
FROM (SELECT phone FROM public.staff_accounts GROUP BY phone HAVING COUNT(*) > 1) duplicates
UNION ALL
SELECT 'noncanonical staff phone format', COUNT(*)::bigint FROM public.staff_accounts
WHERE btrim(phone::text) !~ '^1[3-9][0-9]{9}$'
UNION ALL
SELECT 'duplicate staff auth uids', COUNT(*)::bigint
FROM (SELECT auth_uid FROM public.staff_accounts WHERE auth_uid IS NOT NULL GROUP BY auth_uid HAVING COUNT(*) > 1) duplicates
UNION ALL
SELECT 'active teacher missing active staff', COUNT(*)::bigint
FROM public.teachers t LEFT JOIN public.staff_accounts a ON a.id = t.staff_account_id
WHERE t.teacher_status = 'ACTIVE' AND (a.id IS NULL OR a.role_code <> 'teacher' OR a.account_status <> 'ACTIVE')
UNION ALL
SELECT 'active teacher account missing teacher profile', COUNT(*)::bigint
FROM public.staff_accounts a LEFT JOIN public.teachers t ON t.staff_account_id = a.id
WHERE a.role_code = 'teacher' AND a.account_status = 'ACTIVE' AND (t.id IS NULL OR t.teacher_status <> 'ACTIVE');

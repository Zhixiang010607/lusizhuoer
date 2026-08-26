-- 063 read-only verification 2/2: defaults, backend access and balance guard.

WITH namespace AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
owners AS (
  SELECT class.relowner AS oid FROM pg_class AS class JOIN namespace ON namespace.oid = class.relnamespace
  UNION SELECT proc.proowner FROM pg_proc AS proc JOIN namespace ON namespace.oid = proc.pronamespace
  UNION SELECT CURRENT_USER::regrole::oid
), bad_defaults AS (
  SELECT 1 FROM pg_default_acl AS defaults
  CROSS JOIN LATERAL ACLEXPLODE(defaults.defaclacl) AS privilege
  LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
  WHERE defaults.defaclnamespace IN (0, (SELECT oid FROM namespace))
    AND defaults.defaclobjtype IN ('r', 'S', 'f')
    AND (privilege.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
), bad_function_defaults AS (
  SELECT 1 FROM owners AS owner
  LEFT JOIN pg_default_acl AS defaults ON defaults.defaclrole = owner.oid
    AND defaults.defaclnamespace = 0 AND defaults.defaclobjtype = 'f'
  CROSS JOIN LATERAL ACLEXPLODE(COALESCE(defaults.defaclacl, ACLDEFAULT('f', owner.oid))) AS privilege
  WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
), guard AS (
  SELECT COALESCE(PG_GET_FUNCTIONDEF(
    TO_REGPROCEDURE('public.enforce_paid_verification_available_balance_v63()')), '') AS source
), checks AS (
  SELECT 1 AS sort_order, 'future client defaults closed'::TEXT AS check_name,
    ((SELECT COUNT(*) FROM bad_defaults) + (SELECT COUNT(*) FROM bad_function_defaults))::BIGINT AS record_count
  UNION ALL
  SELECT 2, 'service role retained', CASE WHEN
    HAS_SCHEMA_PRIVILEGE('service_role', 'public', 'USAGE')
    AND HAS_TABLE_PRIVILEGE('service_role', 'public.staff_accounts', 'SELECT')
    AND HAS_TABLE_PRIVILEGE('service_role', 'public.recharge_records', 'INSERT')
    AND HAS_TABLE_PRIVILEGE('service_role', 'public.verification_records', 'INSERT')
    AND COALESCE(HAS_FUNCTION_PRIVILEGE('service_role', TO_REGPROCEDURE(
      'public.review_order_application(character varying,bigint,bigint,character varying,text)'), 'EXECUTE'), FALSE)
    THEN 0 ELSE 1 END::BIGINT
  UNION ALL
  SELECT 3, 'paid verification balance trigger', CASE WHEN EXISTS (
    SELECT 1 FROM pg_trigger AS trigger
     WHERE trigger.tgrelid = TO_REGCLASS('public.verification_records')
       AND trigger.tgname = 'trg_063_paid_verification_balance'
       AND trigger.tgenabled <> 'D' AND NOT trigger.tgisinternal)
    THEN 0 ELSE 1 END::BIGINT
  UNION ALL
  SELECT 4, 'paid verification balance guard body', CASE WHEN
    source LIKE '%PAID_VERIFICATION_BALANCE_GUARD_V63%'
    AND source LIKE '%FOR UPDATE%'
    AND source LIKE '%insufficient purchased units%'
    AND source LIKE '%verification_type IN (''NORMAL'', ''SUPPLEMENT'')%'
    THEN 0 ELSE 1 END::BIGINT FROM guard
)
SELECT check_name, record_count,
       CASE WHEN record_count = 0 THEN 'READY' ELSE 'UNSAFE' END AS status
  FROM checks ORDER BY sort_order;

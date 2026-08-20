-- Read-only diagnostic for the 047 operation-role retirement migration.
-- "core" rows must be READY. "legacy optional" rows may be MISSING: the
-- compatible 047-01 migration simply skips those old tables when absent.

WITH checked_objects (requirement, kind, object_name, ready) AS (
  VALUES
    ('core', 'table', 'public.staff_accounts', to_regclass('public.staff_accounts') IS NOT NULL),
    ('legacy optional', 'table', 'public.operation_profiles', to_regclass('public.operation_profiles') IS NOT NULL),
    ('legacy optional', 'table', 'public.operation_store_scopes', to_regclass('public.operation_store_scopes') IS NOT NULL),
    ('legacy optional', 'table', 'public.account_role_assignments', to_regclass('public.account_role_assignments') IS NOT NULL),
    ('legacy optional', 'table', 'public.account_identity_links', to_regclass('public.account_identity_links') IS NOT NULL),
    ('legacy optional', 'table', 'public.access_roles', to_regclass('public.access_roles') IS NOT NULL),
    ('legacy optional', 'table', 'public.role_permissions', to_regclass('public.role_permissions') IS NOT NULL),
    ('core', 'table', 'public.recharge_records', to_regclass('public.recharge_records') IS NOT NULL),
    ('core', 'table', 'public.verification_records', to_regclass('public.verification_records') IS NOT NULL),
    ('core', 'function', 'public.review_order_application(varchar,bigint,bigint,varchar,text)',
      to_regprocedure('public.review_order_application(character varying,bigint,bigint,character varying,text)') IS NOT NULL),
    ('core 046', 'table', 'public.teacher_product_experience_quotas', to_regclass('public.teacher_product_experience_quotas') IS NOT NULL),
    ('core 046', 'table', 'public.teacher_experience_quota_usages', to_regclass('public.teacher_experience_quota_usages') IS NOT NULL),
    ('core 046', 'function', 'public.reset_teacher_experience_quotas(date,bigint)',
      to_regprocedure('public.reset_teacher_experience_quotas(date,bigint)') IS NOT NULL)
)
SELECT requirement,
       kind,
       object_name,
       CASE WHEN ready THEN 'READY' ELSE 'MISSING' END AS status
  FROM checked_objects
 ORDER BY requirement, ready, kind, object_name;

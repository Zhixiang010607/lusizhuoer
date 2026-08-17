-- Restrict operation accounts to their own profile and the shared HQ review workflow.
-- Existing store-scope rows are archived for audit instead of deleted.
BEGIN;

DO $migration$
BEGIN
  IF to_regclass('public.staff_accounts') IS NULL
     OR to_regclass('public.operation_store_scopes') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regprocedure('public.current_staff_role()') IS NULL
     OR to_regprocedure('public.current_staff_account_id()') IS NULL THEN
    RAISE EXCEPTION
      'operation permission prerequisites are missing; execute the earlier account and access-scope migrations first';
  END IF;
END
$migration$;

-- Close the race between archiving legacy scopes and installing the guard.
-- The lock is held until COMMIT, so no concurrent writer can leave an ACTIVE
-- operation scope between these two steps.
LOCK TABLE public.operation_store_scopes IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operation_store_scopes'
       AND column_name = 'archived_at'
  ) THEN
    EXECUTE 'UPDATE public.operation_store_scopes
                SET scope_status = ''ARCHIVED'',
                    archived_at = COALESCE(archived_at, NOW())
              WHERE scope_status = ''ACTIVE''';
  ELSIF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'operation_store_scopes'
       AND column_name = 'updated_at'
  ) THEN
    EXECUTE 'UPDATE public.operation_store_scopes
                SET scope_status = ''ARCHIVED'', updated_at = NOW()
              WHERE scope_status = ''ACTIVE''';
  ELSE
    EXECUTE 'UPDATE public.operation_store_scopes
                SET scope_status = ''ARCHIVED''
              WHERE scope_status = ''ACTIVE''';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION public.reject_active_operation_store_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.scope_status = 'ACTIVE' THEN
    RAISE EXCEPTION 'operation accounts no longer receive store data scopes'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_reject_active_operation_store_scope
  ON public.operation_store_scopes;
CREATE TRIGGER trg_reject_active_operation_store_scope
BEFORE INSERT OR UPDATE OF scope_status ON public.operation_store_scopes
FOR EACH ROW EXECUTE FUNCTION public.reject_active_operation_store_scope();

ALTER TABLE public.operation_store_scopes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operation_scopes_read ON public.operation_store_scopes;
DROP POLICY IF EXISTS operation_scope_self_or_hq_read ON public.operation_store_scopes;
DROP POLICY IF EXISTS operation_scopes_hq_read ON public.operation_store_scopes;
CREATE POLICY operation_scopes_hq_read
ON public.operation_store_scopes
FOR SELECT TO authenticated
USING (public.current_staff_role() = 'hq');

DROP POLICY IF EXISTS products_active_read ON public.products;
CREATE POLICY products_active_read
ON public.products
FOR SELECT TO authenticated
USING (
  public.current_staff_role() = 'hq'
  OR (
    public.current_staff_role() IN ('store', 'teacher')
    AND product_status = 'ACTIVE'
  )
);

-- Legacy reporting views were created with owner rights. The web application
-- no longer reads them directly, so revoke browser roles explicitly to prevent
-- a view grant from bypassing the stricter base-table RLS rules above.
DO $migration$
DECLARE
  legacy_view text;
BEGIN
  FOREACH legacy_view IN ARRAY ARRAY[
    'v_account_access',
    'v_product_store_summary',
    'v_product_teacher_summary',
    'v_store_global_view',
    'v_teacher_global_view',
    'v_hq_global_view'
  ]
  LOOP
    IF to_regclass('public.' || legacy_view) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE SELECT ON public.%I FROM authenticated, PUBLIC',
        legacy_view
      );
    END IF;
  END LOOP;
END
$migration$;

-- Some rebuild deployments intentionally omit the metadata permission tables.
-- Keep this migration compatible with both database layouts.
DO $migration$
BEGIN
  IF to_regclass('public.role_permissions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.role_permissions WHERE role_code = ''operation''';
    EXECUTE 'INSERT INTO public.role_permissions(role_code, permission_code)
             VALUES (''operation'', ''profile.read.own''),
                    (''operation'', ''review.approve'')
             ON CONFLICT (role_code, permission_code) DO NOTHING';
  END IF;
END
$migration$;

-- DROP is deliberately RESTRICT. Unknown external dependencies abort and roll
-- back the complete migration rather than being removed through CASCADE.
DROP VIEW IF EXISTS public.v_operation_global_view;
CREATE VIEW public.v_operation_global_view AS
SELECT
  a.id AS operation_staff_id,
  a.id AS operation_account_id,
  a.staff_name,
  a.phone,
  a.account_status
FROM public.staff_accounts a
WHERE a.role_code = 'operation'
  AND (
    a.id = public.current_staff_account_id()
    OR public.current_staff_role() = 'hq'
  );

COMMENT ON VIEW public.v_operation_global_view IS
  'Migration 034: operation accounts see only their own profile; HQ may manage all operation profiles.';

COMMIT;

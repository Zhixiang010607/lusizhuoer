-- Migration 047, CloudBase SQL console part 1 of 2.
-- Execute part 1 first, then part 2.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.staff_accounts') IS NULL
     OR to_regclass('public.recharge_records') IS NULL
     OR to_regclass('public.verification_records') IS NULL
     OR to_regprocedure('public.review_order_application(character varying,bigint,bigint,character varying,text)') IS NULL THEN
    RAISE EXCEPTION
      'operation retirement core prerequisites are missing; execute migrations through 046 first';
  END IF;
END;
$$;

-- Current installations can predate the optional operation-profile/role
-- tables. Those tables are archived when present; only the account and review
-- records are core prerequisites. Historic staff IDs always remain in place.
LOCK TABLE public.staff_accounts IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.reject_retired_operation_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.role_code = 'operation' THEN
    RAISE EXCEPTION 'operation accounts are retired' USING ERRCODE = '42501';
  END IF;

  IF NEW.role_code = 'operation' THEN
    IF TG_OP = 'UPDATE'
       AND OLD.role_code = 'operation'
       AND NEW.account_status = 'ARCHIVED' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'operation accounts may only remain archived historic rows'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.role_code = 'operation' THEN
    RAISE EXCEPTION 'historic operation accounts cannot be repurposed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_retired_operation_account ON public.staff_accounts;
CREATE TRIGGER trg_reject_retired_operation_account
BEFORE INSERT OR UPDATE OF role_code, account_status ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.reject_retired_operation_account();

CREATE OR REPLACE FUNCTION public.reject_active_operation_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.profile_status <> 'ARCHIVED' THEN
    RAISE EXCEPTION 'operation profiles are retained only as archived history'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.operation_profiles') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_reject_active_operation_profile ON public.operation_profiles';
    EXECUTE 'CREATE TRIGGER trg_reject_active_operation_profile
      BEFORE INSERT OR UPDATE OF profile_status ON public.operation_profiles
      FOR EACH ROW EXECUTE FUNCTION public.reject_active_operation_profile()';
  END IF;
END;
$$;

UPDATE public.staff_accounts
   SET account_status = 'ARCHIVED', updated_at = NOW()
 WHERE role_code = 'operation'
   AND account_status IS DISTINCT FROM 'ARCHIVED';

DO $$
BEGIN
  IF to_regclass('public.operation_profiles') IS NOT NULL THEN
    EXECUTE 'UPDATE public.operation_profiles
                SET profile_status = ''ARCHIVED'', updated_at = NOW()
              WHERE profile_status IS DISTINCT FROM ''ARCHIVED''';
  END IF;
  IF to_regclass('public.account_role_assignments') IS NOT NULL THEN
    EXECUTE 'UPDATE public.account_role_assignments
                SET grant_status = ''ARCHIVED'', archived_at = COALESCE(archived_at, NOW())
              WHERE role_code = ''operation''
                AND grant_status IS DISTINCT FROM ''ARCHIVED''';
  END IF;
  IF to_regclass('public.account_identity_links') IS NOT NULL THEN
    EXECUTE 'UPDATE public.account_identity_links
                SET link_status = ''ARCHIVED'', archived_at = COALESCE(archived_at, NOW())
              WHERE subject_type = ''operation''
                AND link_status IS DISTINCT FROM ''ARCHIVED''';
  END IF;
  IF to_regclass('public.operation_store_scopes') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'operation_store_scopes'
         AND column_name = 'archived_at'
    ) THEN
      EXECUTE 'UPDATE public.operation_store_scopes
                  SET scope_status = ''ARCHIVED'',
                      archived_at = COALESCE(archived_at, NOW())
                WHERE scope_status IS DISTINCT FROM ''ARCHIVED''';
    ELSE
      EXECUTE 'UPDATE public.operation_store_scopes
                  SET scope_status = ''ARCHIVED'', updated_at = NOW()
                WHERE scope_status IS DISTINCT FROM ''ARCHIVED''';
    END IF;
  END IF;
  IF to_regclass('public.access_roles') IS NOT NULL THEN
    EXECUTE 'UPDATE public.access_roles
                SET role_status = ''ARCHIVED''
              WHERE role_code = ''operation''
                AND role_status IS DISTINCT FROM ''ARCHIVED''';
  END IF;
  IF to_regclass('public.role_permissions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.role_permissions WHERE role_code = ''operation''';
  END IF;
END;
$$;

COMMIT;

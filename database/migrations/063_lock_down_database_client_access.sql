-- Migration 063: remove direct PostgreSQL access from untrusted client roles
-- and reject paid verification overdraw before the order becomes effective.
--
-- Web and mini-program clients must call the CloudBase cloud functions.  Only
-- the trusted service_role and database object owners retain direct access.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'migration 063 requires CloudBase roles anon, authenticated and service_role';
  END IF;
  IF TO_REGCLASS('public.customers') IS NULL
     OR TO_REGCLASS('public.recharge_records') IS NULL
     OR TO_REGCLASS('public.verification_records') IS NULL
     OR TO_REGCLASS('public.customer_product_balances') IS NULL THEN
    RAISE EXCEPTION 'core business tables must exist before migration 063';
  END IF;
END;
$$;

-- Existing objects: clients have no direct schema, table, sequence or routine
-- access.  Cloud functions continue through the trusted service role.
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Future objects: remove the provider defaults that previously granted anon
-- reads, authenticated writes and PUBLIC routine execution.  Cover every
-- current public-schema object owner plus the role running this migration.
DO $$
DECLARE
  owner_row RECORD;
BEGIN
  FOR owner_row IN
    WITH public_object_owners AS (
      SELECT CURRENT_USER::TEXT AS role_name
      UNION
      SELECT PG_GET_USERBYID(class.relowner)
        FROM pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
       WHERE namespace.nspname = 'public'
      UNION
      SELECT PG_GET_USERBYID(proc.proowner)
        FROM pg_proc AS proc
        JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
       WHERE namespace.nspname = 'public'
      UNION
      SELECT PG_GET_USERBYID(default_acl.defaclrole)
        FROM pg_default_acl AS default_acl
       WHERE default_acl.defaclnamespace IN (0, 'public'::regnamespace::oid)
    )
    SELECT role_name
      FROM public_object_owners
     WHERE role_name IS NOT NULL
     ORDER BY role_name
  LOOP
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated', owner_row.role_name);

    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL ON TABLES TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL ON SEQUENCES TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON TABLES TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role', owner_row.role_name);
  END LOOP;
END;
$$;

LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.enforce_paid_verification_available_balance_v63()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  purchased_units BIGINT := 0;
  consumed_units BIGINT := 0;
  materialized_remaining_units BIGINT := 0;
  available_units BIGINT := 0;
BEGIN
  -- PAID_VERIFICATION_BALANCE_GUARD_V63
  IF NEW.verification_type NOT IN ('NORMAL', 'SUPPLEMENT')
     OR NEW.record_status <> 'APPROVED' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.record_status = 'APPROVED' THEN
    RETURN NEW;
  END IF;

  -- Serialize recharge/refund approval and paid verification for this
  -- customer.  The source-of-truth aggregates are recalculated while locked.
  PERFORM 1
    FROM public.customers AS customer
   WHERE customer.id = NEW.customer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer % does not exist', NEW.customer_id
      USING ERRCODE = '23503';
  END IF;

  SELECT GREATEST(balance.remaining_count, 0)::BIGINT
    INTO materialized_remaining_units
    FROM public.customer_product_balances AS balance
   WHERE balance.customer_id = NEW.customer_id
     AND balance.product_id = NEW.product_id
   FOR UPDATE;
  materialized_remaining_units := COALESCE(materialized_remaining_units, 0);

  SELECT GREATEST(COALESCE(SUM(
           CASE WHEN recharge.recharge_type = 'NEW'
                THEN recharge.unit_count ELSE -recharge.unit_count END
         ), 0), 0)::BIGINT
    INTO purchased_units
    FROM public.recharge_records AS recharge
   WHERE recharge.customer_id = NEW.customer_id
     AND recharge.product_id = NEW.product_id
     AND recharge.record_status = 'APPROVED';

  SELECT COALESCE(SUM(verification.unit_count), 0)::BIGINT
    INTO consumed_units
    FROM public.verification_records AS verification
   WHERE verification.customer_id = NEW.customer_id
     AND verification.product_id = NEW.product_id
     AND verification.record_status = 'APPROVED'
     AND verification.verification_type IN ('NORMAL', 'SUPPLEMENT');

  -- Fail closed on either source: the locked materialized balance prevents two
  -- concurrent verifications spending the same last unit, while the aggregate
  -- protects against a stale or over-generous materialized row.
  available_units := LEAST(
    materialized_remaining_units,
    GREATEST(purchased_units - consumed_units, 0)
  );
  IF available_units < NEW.unit_count THEN
    RAISE EXCEPTION 'insufficient purchased units for customer % and product %',
      NEW.customer_id, NEW.product_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_063_paid_verification_balance ON public.verification_records;
CREATE TRIGGER trg_063_paid_verification_balance
BEFORE INSERT OR UPDATE OF record_status ON public.verification_records
FOR EACH ROW
EXECUTE FUNCTION public.enforce_paid_verification_available_balance_v63();

REVOKE ALL ON FUNCTION public.enforce_paid_verification_available_balance_v63()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_paid_verification_available_balance_v63()
  TO service_role;

COMMENT ON FUNCTION public.enforce_paid_verification_available_balance_v63() IS
  'Migration 063: rejects NORMAL/SUPPLEMENT approval when current purchased balance is insufficient; serializes on the customer row.';

COMMIT;

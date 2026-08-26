-- 063 emergency step 3: a paid verification cannot consume unavailable units.
-- EXPERIENCE is intentionally excluded because it consumes teacher quota.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.customers') IS NULL
     OR TO_REGCLASS('public.recharge_records') IS NULL
     OR TO_REGCLASS('public.verification_records') IS NULL
     OR TO_REGCLASS('public.customer_product_balances') IS NULL THEN
    RAISE EXCEPTION 'core business tables must exist before 063-03';
  END IF;
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

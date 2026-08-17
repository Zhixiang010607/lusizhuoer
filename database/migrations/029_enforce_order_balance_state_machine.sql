BEGIN;

-- Required deployment order:
--   021_customer_product_effective_balances.sql
--   026_order_review_and_void_workflow.sql
--   028_fix_review_order_status_ambiguity.sql
--   029_enforce_order_balance_state_machine.sql
--
-- Balance effects enforced by this migration:
--   recharge PENDING / REJECTED                    -> no effect
--   recharge APPROVED                             -> add units
--   recharge void request PENDING / REJECTED      -> no effect
--   recharge void request APPROVED (VOIDED order) -> remove units
--   NORMAL verification inserted APPROVED         -> consume units immediately
--   SUPPLEMENT verification PENDING / REJECTED    -> no effect
--   SUPPLEMENT verification APPROVED              -> consume units
--   EXPERIENCE verification                       -> never consumes purchased units
--   verification void request PENDING / REJECTED  -> no effect
--   verification void request APPROVED (VOIDED)   -> restore consumed units

DO $$
BEGIN
  IF TO_REGPROCEDURE('public.refresh_customer_balance(bigint)') IS NULL THEN
    RAISE EXCEPTION 'migration 021 must be executed before migration 029';
  END IF;
  IF TO_REGPROCEDURE('public.request_order_void(character varying,bigint,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 026 must be executed before migration 029';
  END IF;
  IF TO_REGPROCEDURE('public.review_order_application(character varying,bigint,bigint,character varying,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 028 must be executed before migration 029';
  END IF;
END;
$$;

LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.customer_product_balances IN SHARE ROW EXCLUSIVE MODE;

-- Remove the old incremental implementation if an earlier schema was once
-- installed. Derived balances must have exactly one source of truth.
DROP TRIGGER IF EXISTS trg_apply_recharge_balance ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_apply_verification_balance ON public.verification_records;

-- An order is an audit record. Customer, store, product, type and unit count
-- cannot be rewritten after submission. Approval and voiding only change the
-- status fields; this guarantees that one status transition has one effect.
CREATE OR REPLACE FUNCTION public.guard_order_balance_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'recharge_records' THEN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.unit_count IS DISTINCT FROM OLD.unit_count
       OR NEW.recharge_type IS DISTINCT FROM OLD.recharge_type
       OR NEW.original_recharge_id IS DISTINCT FROM OLD.original_recharge_id THEN
      RAISE EXCEPTION 'submitted recharge business fields are immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'verification_records' THEN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.unit_count IS DISTINCT FROM OLD.unit_count
       OR NEW.verification_type IS DISTINCT FROM OLD.verification_type THEN
      RAISE EXCEPTION 'submitted verification business fields are immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recharge_guard_balance_fields
ON public.recharge_records;
CREATE TRIGGER trg_recharge_guard_balance_fields
BEFORE UPDATE ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.guard_order_balance_fields();

DROP TRIGGER IF EXISTS trg_verification_guard_balance_fields
ON public.verification_records;
CREATE TRIGGER trg_verification_guard_balance_fields
BEFORE UPDATE ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.guard_order_balance_fields();

-- Reject direct or accidental status jumps. The review function performs the
-- valid transitions while holding the order row and customer row locks.
CREATE OR REPLACE FUNCTION public.guard_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'recharge_records' THEN
      IF NEW.recharge_type <> 'NEW' THEN
        RAISE EXCEPTION 'a void request must reuse the original recharge order'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a recharge application must start as PENDING'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'verification_records' THEN
      IF NEW.verification_type = 'NORMAL' AND NEW.record_status <> 'APPROVED' THEN
        RAISE EXCEPTION 'a NORMAL verification must be effective immediately'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.verification_type IN ('SUPPLEMENT', 'EXPERIENCE')
         AND NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a reviewed verification must start as PENDING'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.record_status IS NOT DISTINCT FROM OLD.record_status THEN
    RETURN NEW;
  END IF;

  IF OLD.record_status = 'PENDING'
     AND NEW.record_status IN ('APPROVED', 'REJECTED') THEN
    RETURN NEW;
  END IF;

  IF OLD.record_status = 'APPROVED'
     AND NEW.record_status = 'VOIDED'
     AND NEW.void_request_status = 'APPROVED' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid order status transition: % -> %',
    OLD.record_status, NEW.record_status
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_recharge_guard_status_transition
ON public.recharge_records;
CREATE TRIGGER trg_recharge_guard_status_transition
BEFORE INSERT OR UPDATE OF record_status ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.guard_order_status_transition();

DROP TRIGGER IF EXISTS trg_verification_guard_status_transition
ON public.verification_records;
CREATE TRIGGER trg_verification_guard_status_transition
BEFORE INSERT OR UPDATE OF record_status ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.guard_order_status_transition();

-- Recalculate only when an order is inserted, deleted or its effective status
-- changes. Notes and pending void requests therefore never add, remove or
-- unnecessarily recalculate customer units.
DROP TRIGGER IF EXISTS trg_recharge_refresh_customer_balance
ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_verification_refresh_customer_balance
ON public.verification_records;

DROP TRIGGER IF EXISTS trg_recharge_balance_insert
ON public.recharge_records;
CREATE TRIGGER trg_recharge_balance_insert
AFTER INSERT ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.refresh_customer_balance_after_order();

DROP TRIGGER IF EXISTS trg_recharge_balance_status_update
ON public.recharge_records;
CREATE TRIGGER trg_recharge_balance_status_update
AFTER UPDATE OF record_status ON public.recharge_records
FOR EACH ROW
WHEN (OLD.record_status IS DISTINCT FROM NEW.record_status)
EXECUTE FUNCTION public.refresh_customer_balance_after_order();

DROP TRIGGER IF EXISTS trg_recharge_balance_delete
ON public.recharge_records;
CREATE TRIGGER trg_recharge_balance_delete
AFTER DELETE ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.refresh_customer_balance_after_order();

DROP TRIGGER IF EXISTS trg_verification_balance_insert
ON public.verification_records;
CREATE TRIGGER trg_verification_balance_insert
AFTER INSERT ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.refresh_customer_balance_after_order();

DROP TRIGGER IF EXISTS trg_verification_balance_status_update
ON public.verification_records;
CREATE TRIGGER trg_verification_balance_status_update
AFTER UPDATE OF record_status ON public.verification_records
FOR EACH ROW
WHEN (OLD.record_status IS DISTINCT FROM NEW.record_status)
EXECUTE FUNCTION public.refresh_customer_balance_after_order();

DROP TRIGGER IF EXISTS trg_verification_balance_delete
ON public.verification_records;
CREATE TRIGGER trg_verification_balance_delete
AFTER DELETE ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.refresh_customer_balance_after_order();

COMMENT ON FUNCTION public.refresh_customer_balance(BIGINT) IS
  'Derives effective balances from approved orders. Pending/rejected orders and pending/rejected void requests have no effect; approved recharge voids remove units; approved NORMAL/SUPPLEMENT verification voids restore units; EXPERIENCE never consumes purchased units.';

-- Repair any historical drift once. The customer row lock used by the refresh
-- function also serializes concurrent approvals for the same customer.
DO $$
DECLARE
  customer_row RECORD;
BEGIN
  FOR customer_row IN SELECT id FROM public.customers ORDER BY id LOOP
    PERFORM public.refresh_customer_balance(customer_row.id);
  END LOOP;
END;
$$;

COMMIT;

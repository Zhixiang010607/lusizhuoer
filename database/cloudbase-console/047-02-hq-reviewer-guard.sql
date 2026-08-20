-- Migration 047, CloudBase SQL console part 2 of 2.
-- Execute part 1 first, then part 2.

BEGIN;

CREATE OR REPLACE FUNCTION public.review_order_application(
  p_record_type VARCHAR,
  p_record_id BIGINT,
  p_actor_account_id BIGINT,
  p_decision VARCHAR,
  p_note TEXT
)
RETURNS TABLE(record_id BIGINT, record_code TEXT, record_status TEXT,
              void_request_status TEXT, reviewed_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  actor_role TEXT;
  decision TEXT := UPPER(COALESCE(p_decision, ''));
  current_status TEXT;
  current_void_status TEXT;
  current_code TEXT;
  current_type TEXT;
  recharge_customer_id BIGINT;
  recharge_product_id BIGINT;
  recharge_units INTEGER;
  refundable_units BIGINT;
  current_remaining BIGINT;
BEGIN
  SELECT a.role_code INTO actor_role FROM public.staff_accounts a
   WHERE a.id = p_actor_account_id AND a.account_status = 'ACTIVE';
  IF actor_role IS DISTINCT FROM 'hq' THEN
    RAISE EXCEPTION 'only headquarters can review orders' USING ERRCODE = '42501';
  END IF;
  IF decision NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'decision must be APPROVED or REJECTED' USING ERRCODE = '22023';
  END IF;
  IF LENGTH(COALESCE(p_note, '')) > 1000 THEN
    RAISE EXCEPTION 'review note is too long' USING ERRCODE = '22001';
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' THEN
    SELECT r.record_status, r.void_request_status, r.recharge_code, r.recharge_type,
           r.customer_id, r.product_id, r.unit_count
      INTO current_status, current_void_status, current_code, current_type,
           recharge_customer_id, recharge_product_id, recharge_units
      FROM public.recharge_records r WHERE r.id = p_record_id FOR UPDATE;
  ELSIF UPPER(p_record_type) = 'VERIFICATION' THEN
    SELECT v.record_status, v.void_request_status, v.verification_code
      INTO current_status, current_void_status, current_code
      FROM public.verification_records v WHERE v.id = p_record_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'unsupported record type' USING ERRCODE = '22023';
  END IF;
  IF current_code IS NULL THEN RAISE EXCEPTION 'order does not exist' USING ERRCODE = 'P0002'; END IF;
  IF current_void_status <> 'NONE' OR current_status <> 'PENDING' THEN
    RAISE EXCEPTION 'this application is no longer pending' USING ERRCODE = '23514';
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' AND current_type = 'REFUND' AND decision = 'APPROVED' THEN
    PERFORM 1 FROM public.customers c WHERE c.id = recharge_customer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'customer does not exist' USING ERRCODE = 'P0002'; END IF;

    SELECT COALESCE(SUM(CASE WHEN r.recharge_type = 'NEW' THEN r.unit_count ELSE -r.unit_count END), 0)
      INTO refundable_units
      FROM public.recharge_records r
     WHERE r.customer_id = recharge_customer_id
       AND r.product_id = recharge_product_id
       AND r.record_status = 'APPROVED';
    IF recharge_units > refundable_units THEN
      RAISE EXCEPTION 'refund units exceed unrefunded purchased units' USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(b.remaining_count, 0) INTO current_remaining
      FROM public.customer_product_balances b
     WHERE b.customer_id = recharge_customer_id AND b.product_id = recharge_product_id;
    current_remaining := COALESCE(current_remaining, 0);
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' THEN
    UPDATE public.recharge_records r
       SET record_status = decision,
           reviewed_by_account_id = p_actor_account_id,
           reviewed_at = NOW(),
           review_note = BTRIM(COALESCE(p_note, '')),
           balance_after_count = CASE
             WHEN current_type = 'REFUND' AND decision = 'APPROVED'
               THEN GREATEST(current_remaining - recharge_units, 0)::INTEGER
             ELSE r.balance_after_count
           END,
           updated_at = NOW()
     WHERE r.id = p_record_id;
  ELSE
    UPDATE public.verification_records v
       SET record_status = decision,
           reviewed_by_account_id = p_actor_account_id,
           reviewed_at = NOW(),
           review_note = BTRIM(COALESCE(p_note, '')),
           updated_at = NOW()
     WHERE v.id = p_record_id;
  END IF;

  RETURN QUERY SELECT p_record_id, current_code, decision, current_void_status, NOW();
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_hq_order_reviewer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reviewer_role TEXT;
BEGIN
  IF NEW.reviewed_by_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT role_code INTO reviewer_role
    FROM public.staff_accounts
   WHERE id = NEW.reviewed_by_account_id
     AND account_status = 'ACTIVE';
  IF reviewer_role IS DISTINCT FROM 'hq' THEN
    RAISE EXCEPTION 'only active headquarters accounts may review orders'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_hq_recharge_reviewer ON public.recharge_records;
CREATE TRIGGER trg_enforce_hq_recharge_reviewer
BEFORE INSERT OR UPDATE OF reviewed_by_account_id ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_hq_order_reviewer();

DROP TRIGGER IF EXISTS trg_enforce_hq_verification_reviewer ON public.verification_records;
CREATE TRIGGER trg_enforce_hq_verification_reviewer
BEFORE INSERT OR UPDATE OF reviewed_by_account_id ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_hq_order_reviewer();

REVOKE ALL ON FUNCTION public.reject_retired_operation_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_active_operation_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_order_application(VARCHAR, BIGINT, BIGINT, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_hq_order_reviewer() FROM PUBLIC;

COMMENT ON FUNCTION public.reject_retired_operation_account() IS
  'Migration 047: operation accounts remain archived historic rows only.';
COMMENT ON FUNCTION public.review_order_application(VARCHAR, BIGINT, BIGINT, VARCHAR, TEXT) IS
  'Migration 047: only active headquarters accounts may review orders.';

COMMIT;

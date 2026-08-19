-- Migration 044, CloudBase SQL console part 2 of 2.
-- Execute part 1 first, then part 2.

BEGIN;

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
       OR NEW.original_recharge_id IS DISTINCT FROM OLD.original_recharge_id
       OR NEW.balance_before_count IS DISTINCT FROM OLD.balance_before_count THEN
      RAISE EXCEPTION 'submitted recharge business fields are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.balance_after_count IS DISTINCT FROM OLD.balance_after_count
       AND NOT (OLD.balance_after_count IS NULL
                AND OLD.record_status = 'PENDING'
                AND NEW.record_status = 'APPROVED'
                AND NEW.recharge_type = 'REFUND'
                AND NEW.balance_after_count >= 0) THEN
      RAISE EXCEPTION 'refund result snapshot can only be set during approval' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'verification_records' THEN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.unit_count IS DISTINCT FROM OLD.unit_count
       OR NEW.verification_type IS DISTINCT FROM OLD.verification_type THEN
      RAISE EXCEPTION 'submitted verification business fields are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'recharge_records' THEN
      IF NEW.recharge_type NOT IN ('NEW', 'REFUND') THEN
        RAISE EXCEPTION 'new recharge orders must be NEW or REFUND' USING ERRCODE = '23514';
      END IF;
      IF NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a recharge or refund application must start as PENDING' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'verification_records' THEN
      IF NEW.verification_type = 'NORMAL' AND NEW.record_status <> 'APPROVED' THEN
        RAISE EXCEPTION 'a NORMAL verification must be effective immediately' USING ERRCODE = '23514';
      END IF;
      IF NEW.verification_type IN ('SUPPLEMENT', 'EXPERIENCE') AND NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a reviewed verification must start as PENDING' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.record_status IS NOT DISTINCT FROM OLD.record_status THEN RETURN NEW; END IF;
  IF OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED', 'REJECTED') THEN RETURN NEW; END IF;
  IF OLD.record_status = 'APPROVED' AND NEW.record_status = 'VOIDED' AND NEW.void_request_status = 'APPROVED' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid order status transition: % -> %', OLD.record_status, NEW.record_status USING ERRCODE = '23514';
END;
$$;

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
  IF actor_role NOT IN ('hq', 'operation') THEN
    RAISE EXCEPTION 'only headquarters or operations can review orders' USING ERRCODE = '42501';
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

CREATE INDEX IF NOT EXISTS idx_recharge_refund_review
  ON public.recharge_records (recharge_type, record_status, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');

-- Rebuild all summaries under the new zero-floor rule.
DO $$
DECLARE customer_row RECORD;
BEGIN
  FOR customer_row IN SELECT id FROM public.customers ORDER BY id LOOP
    PERFORM public.refresh_customer_balance(customer_row.id);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.review_order_application(VARCHAR, BIGINT, BIGINT, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_order_balance_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_order_status_transition() FROM PUBLIC;

COMMENT ON COLUMN public.recharge_records.balance_before_count IS
  'Refund application snapshot: available units when the store submitted the order.';
COMMENT ON COLUMN public.recharge_records.balance_after_count IS
  'Refund approval snapshot: available units after applying the approved refund, floored at zero.';
COMMENT ON FUNCTION public.refresh_customer_balance(BIGINT) IS
  'Migration 044: approved NEW units add purchases; approved REFUND/legacy VOID units subtract purchases; available units never fall below zero.';

COMMIT;

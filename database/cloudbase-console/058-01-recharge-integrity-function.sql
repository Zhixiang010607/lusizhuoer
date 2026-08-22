CREATE OR REPLACE FUNCTION public.enforce_current_recharge_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- CURRENT_RECHARGE_INTEGRITY_V58
  IF TG_OP = 'INSERT' THEN
    IF NEW.recharge_type NOT IN ('NEW','REFUND') OR NEW.record_status <> 'PENDING' THEN
      RAISE EXCEPTION 'a current recharge/refund application must start as PENDING' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.recharge_code IS DISTINCT FROM OLD.recharge_code
     OR NEW.recharge_type IS DISTINCT FROM OLD.recharge_type
     OR NEW.original_recharge_id IS DISTINCT FROM OLD.original_recharge_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.unit_count IS DISTINCT FROM OLD.unit_count
     OR NEW.submitted_by_account_id IS DISTINCT FROM OLD.submitted_by_account_id
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.balance_before_count IS DISTINCT FROM OLD.balance_before_count THEN
    RAISE EXCEPTION 'submitted recharge business fields are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    IF OLD.record_status <> 'PENDING' OR NEW.record_status NOT IN ('APPROVED','REJECTED')
       OR NEW.reviewed_by_account_id IS NULL OR NEW.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'invalid recharge status transition: % -> %',OLD.record_status,NEW.record_status USING ERRCODE='23514';
    END IF;
  ELSIF NEW.reviewed_by_account_id IS DISTINCT FROM OLD.reviewed_by_account_id
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_note IS DISTINCT FROM OLD.review_note
     OR NEW.balance_after_count IS DISTINCT FROM OLD.balance_after_count THEN
    RAISE EXCEPTION 'recharge review fields may change only with the pending decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.enforce_current_recharge_integrity() FROM PUBLIC;
COMMENT ON FUNCTION public.enforce_current_recharge_integrity() IS 'Migration 058 current recharge/refund state machine and immutable audit-field guard.';

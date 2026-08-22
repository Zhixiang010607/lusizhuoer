BEGIN;

-- Migration 058 restores database guards for the current workflow.  NEW and
-- REFUND applications start PENDING; NORMAL and EXPERIENCE verifications are
-- created APPROVED atomically.  Historical PENDING verifications may still be
-- reviewed once, but no retired supplement/teacher-face order can be created.
DO $$
BEGIN
  IF TO_REGCLASS('public.recharge_records') IS NULL
     OR TO_REGCLASS('public.verification_records') IS NULL THEN
    RAISE EXCEPTION 'migrations through 057 must be installed before migration 058';
  END IF;
END;
$$;

LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;

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

CREATE OR REPLACE FUNCTION public.enforce_current_verification_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- CURRENT_VERIFICATION_INTEGRITY_V58
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_type NOT IN ('NORMAL','EXPERIENCE') OR NEW.record_status <> 'APPROVED' THEN
      RAISE EXCEPTION 'a current normal/experience verification must be created APPROVED' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.verification_code IS DISTINCT FROM OLD.verification_code
     OR NEW.verification_type IS DISTINCT FROM OLD.verification_type
     OR NEW.store_id IS DISTINCT FROM OLD.store_id OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.unit_count IS DISTINCT FROM OLD.unit_count
     OR NEW.submitted_by_account_id IS DISTINCT FROM OLD.submitted_by_account_id
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.supplement_note IS DISTINCT FROM OLD.supplement_note
     OR NEW.face_request_id IS DISTINCT FROM OLD.face_request_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.face_subject_type IS DISTINCT FROM OLD.face_subject_type
     OR NEW.face_subject_teacher_id IS DISTINCT FROM OLD.face_subject_teacher_id THEN
    RAISE EXCEPTION 'submitted verification business fields are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    IF OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED','REJECTED')
       AND NEW.reviewed_by_account_id IS NOT NULL AND NEW.reviewed_at IS NOT NULL THEN
      NULL;
    ELSIF OLD.record_status = 'APPROVED' AND NEW.record_status = 'VOIDED'
       AND NEW.void_request_status = 'APPROVED' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'invalid verification status transition: % -> %',OLD.record_status,NEW.record_status USING ERRCODE='23514';
    END IF;
  ELSIF NEW.reviewed_by_account_id IS DISTINCT FROM OLD.reviewed_by_account_id
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_note IS DISTINCT FROM OLD.review_note THEN
    RAISE EXCEPTION 'verification review fields may change only with the pending decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_recharge_guard_balance_fields ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_recharge_guard_status_transition ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_verification_guard_balance_fields ON public.verification_records;
DROP TRIGGER IF EXISTS trg_verification_guard_status_transition ON public.verification_records;
DROP TRIGGER IF EXISTS trg_validate_verification_status_transition ON public.verification_records;
DROP TRIGGER IF EXISTS trg_058_recharge_integrity ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_058_verification_integrity ON public.verification_records;

CREATE TRIGGER trg_058_recharge_integrity BEFORE INSERT OR UPDATE ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_current_recharge_integrity();
CREATE TRIGGER trg_058_verification_integrity BEFORE INSERT OR UPDATE ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_current_verification_integrity();

REVOKE ALL ON FUNCTION public.enforce_current_recharge_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_current_verification_integrity() FROM PUBLIC;
COMMENT ON FUNCTION public.enforce_current_recharge_integrity() IS 'Migration 058 current recharge/refund state machine and immutable audit-field guard.';
COMMENT ON FUNCTION public.enforce_current_verification_integrity() IS 'Migration 058 current verification state machine and immutable audit-field guard.';

COMMIT;

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
REVOKE ALL ON FUNCTION public.enforce_current_verification_integrity() FROM PUBLIC;
COMMENT ON FUNCTION public.enforce_current_verification_integrity() IS 'Migration 058 current verification state machine and immutable audit-field guard.';

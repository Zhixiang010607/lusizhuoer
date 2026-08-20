-- CloudBase migration 049, part 12 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.create_experience_verification_with_teacher_face_photo(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR, p_idempotency_key VARCHAR
)
RETURNS TABLE(
  id BIGINT, verification_code TEXT, verification_type TEXT, store_id BIGINT,
  teacher_id BIGINT, customer_id BIGINT, product_id BIGINT, unit_count INTEGER,
  record_status TEXT, submitted_by_account_id BIGINT, submitted_at TIMESTAMPTZ,
  message TEXT, supplement_note TEXT, face_request_id TEXT,
  idempotency_key TEXT, created_now BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  existing_record public.verification_records%ROWTYPE;
  created_record public.verification_records%ROWTYPE;
BEGIN
  IF BTRIM(COALESCE(p_idempotency_key, '')) = ''
     OR BTRIM(COALESCE(p_face_request_id, '')) = ''
     OR BTRIM(COALESCE(p_face_evidence_token, '')) = '' THEN
    RAISE EXCEPTION 'experience verification idempotency and face evidence are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));
  existing_record := public.find_teacher_experience_verification_replay(
    p_store_id, p_teacher_id, p_customer_id, p_product_id, p_submitted_by_account_id,
    p_message, p_face_request_id, p_face_evidence_token, p_idempotency_key
  );
  IF existing_record.id IS NOT NULL THEN
    RETURN QUERY SELECT existing_record.id, existing_record.verification_code::TEXT,
      existing_record.verification_type::TEXT, existing_record.store_id,
      existing_record.teacher_id, existing_record.customer_id, existing_record.product_id,
      existing_record.unit_count, existing_record.record_status::TEXT,
      existing_record.submitted_by_account_id, existing_record.submitted_at,
      existing_record.message, existing_record.supplement_note,
      existing_record.face_request_id::TEXT, existing_record.idempotency_key::TEXT, FALSE;
    RETURN;
  END IF;
  created_record := public.insert_teacher_experience_verification(
    p_store_id, p_teacher_id, p_customer_id, p_product_id, p_submitted_by_account_id,
    p_message, p_face_request_id, p_face_evidence_token, p_idempotency_key
  );
  RETURN QUERY SELECT created_record.id, created_record.verification_code::TEXT,
    created_record.verification_type::TEXT, created_record.store_id,
    created_record.teacher_id, created_record.customer_id, created_record.product_id,
    created_record.unit_count, created_record.record_status::TEXT,
    created_record.submitted_by_account_id, created_record.submitted_at,
    created_record.message, created_record.supplement_note,
    created_record.face_request_id::TEXT, created_record.idempotency_key::TEXT, TRUE;
END;
$$;

COMMIT;

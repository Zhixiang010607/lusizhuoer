-- CloudBase migration 049, part 11 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.insert_teacher_experience_verification(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR, p_idempotency_key VARCHAR
)
RETURNS public.verification_records
LANGUAGE plpgsql
AS $$
DECLARE
  created_record public.verification_records%ROWTYPE;
  profile_object_ref TEXT;
BEGIN
  profile_object_ref := public.lock_active_teacher_experience_subjects(
    p_store_id, p_teacher_id, p_customer_id, p_product_id, p_submitted_by_account_id
  );
  INSERT INTO public.verification_records
    (verification_type, store_id, teacher_id, customer_id, product_id, unit_count,
     record_status, submitted_by_account_id, message, supplement_note,
     face_request_id, idempotency_key, face_subject_type, face_subject_teacher_id)
  VALUES ('EXPERIENCE', p_store_id, p_teacher_id, p_customer_id, p_product_id, 1,
          'APPROVED', p_submitted_by_account_id, COALESCE(p_message, ''), '',
          p_face_request_id, p_idempotency_key, 'TEACHER', p_teacher_id)
  RETURNING * INTO created_record;
  PERFORM public.consume_teacher_experience_quota(
    created_record.id, p_teacher_id, p_product_id
  );
  PERFORM public.bind_teacher_experience_face_photos(
    created_record.id, p_store_id, p_teacher_id, p_customer_id,
    p_submitted_by_account_id, p_face_request_id, p_face_evidence_token,
    profile_object_ref
  );
  INSERT INTO public.device_signal_outbox
    (verification_id, store_id, customer_id, product_id, teacher_id)
  VALUES (created_record.id, created_record.store_id, created_record.customer_id,
          created_record.product_id, created_record.teacher_id);
  RETURN created_record;
END;
$$;

COMMIT;

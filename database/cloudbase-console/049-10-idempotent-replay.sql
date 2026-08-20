-- CloudBase migration 049, part 10 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.find_teacher_experience_verification_replay(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR, p_idempotency_key VARCHAR
)
RETURNS public.verification_records
LANGUAGE plpgsql
AS $$
DECLARE existing_record public.verification_records%ROWTYPE;
BEGIN
  SELECT record.* INTO existing_record FROM public.verification_records AS record
   WHERE record.idempotency_key = p_idempotency_key LIMIT 1;
  IF existing_record.id IS NULL THEN RETURN NULL; END IF;
  PERFORM public.assert_matching_verification_idempotency(
    existing_record.id, 'EXPERIENCE', p_store_id, p_teacher_id, p_customer_id,
    p_product_id, p_submitted_by_account_id, p_message, '', p_face_request_id,
    p_face_evidence_token
  );
  IF existing_record.face_subject_type <> 'TEACHER'
     OR existing_record.face_subject_teacher_id IS DISTINCT FROM p_teacher_id
     OR NOT EXISTS (SELECT 1 FROM public.teacher_experience_quota_usages AS usage
                     WHERE usage.verification_id = existing_record.id) THEN
    RAISE EXCEPTION 'experience verification face or quota audit is invalid' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.device_signal_outbox
    (verification_id, store_id, customer_id, product_id, teacher_id)
  VALUES (existing_record.id, existing_record.store_id, existing_record.customer_id,
          existing_record.product_id, existing_record.teacher_id)
  ON CONFLICT (verification_id) DO NOTHING;
  RETURN existing_record;
END;
$$;

COMMIT;

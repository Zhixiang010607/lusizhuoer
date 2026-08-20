-- CloudBase migration 049, part 9 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.bind_teacher_experience_face_photos(
  p_verification_id BIGINT, p_store_id BIGINT, p_teacher_id BIGINT,
  p_customer_id BIGINT, p_submitted_by_account_id BIGINT,
  p_face_request_id VARCHAR, p_face_evidence_token VARCHAR, p_profile_object_ref TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE draft_row public.verification_photo_drafts%ROWTYPE;
BEGIN
  SELECT draft.* INTO draft_row FROM public.verification_photo_drafts AS draft
   WHERE draft.evidence_token = p_face_evidence_token AND draft.store_id = p_store_id
     AND draft.customer_id = p_customer_id AND draft.submitted_by_account_id = p_submitted_by_account_id
     AND draft.face_request_id = p_face_request_id AND draft.face_subject_type = 'TEACHER'
     AND draft.face_subject_teacher_id = p_teacher_id AND draft.consumed_at IS NULL
     AND draft.expires_at > CLOCK_TIMESTAMP() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher face photo evidence is missing, expired, consumed, or belongs to another request'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref, thumbnail_object_ref,
     original_bytes, thumbnail_bytes, image_width, image_height, sha256,
     uploaded_by_account_id, source_evidence_token, face_subject_type, face_subject_teacher_id)
  VALUES
    (p_verification_id, 0, 'PROFILE', p_profile_object_ref, p_profile_object_ref,
     NULL, NULL, NULL, NULL, NULL, p_submitted_by_account_id, NULL, 'TEACHER', p_teacher_id),
    (p_verification_id, 1, 'FACE', draft_row.original_object_ref, draft_row.thumbnail_object_ref,
     draft_row.original_bytes, draft_row.thumbnail_bytes, draft_row.image_width, draft_row.image_height,
     draft_row.sha256, p_submitted_by_account_id, draft_row.evidence_token, 'TEACHER', p_teacher_id);
  INSERT INTO public.verification_photo_events
    (verification_id, photo_slot, event_type, actor_account_id)
  VALUES (p_verification_id, 0, 'PROFILE_BOUND', p_submitted_by_account_id),
         (p_verification_id, 1, 'FACE_BOUND', p_submitted_by_account_id);
  UPDATE public.verification_photo_drafts
     SET consumed_by_verification_id = p_verification_id, consumed_at = NOW()
   WHERE evidence_token = draft_row.evidence_token;
END;
$$;

COMMIT;

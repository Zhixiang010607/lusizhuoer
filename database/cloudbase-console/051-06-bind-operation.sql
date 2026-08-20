-- CloudBase migration 051, part 6 / 10. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.bind_teacher_face_operation(
  p_operation_id BIGINT, p_owner_token_sha256 VARCHAR, p_lease_generation BIGINT,
  p_auth_uid VARCHAR, p_auth_owner_token_sha256 VARCHAR,
  p_staff_id BIGINT, p_teacher_id BIGINT, p_person_id VARCHAR,
  p_previous_person_id VARCHAR, p_previous_photo_reference TEXT,
  p_previous_face_enrollment_status VARCHAR, p_previous_face_consent_at VARCHAR,
  p_previous_face_enrolled_at VARCHAR, p_previous_face_enrolled_by_account_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE op public.teacher_face_operations%ROWTYPE;
BEGIN
  SELECT operation.* INTO op FROM public.teacher_face_operations AS operation
   WHERE operation.id = p_operation_id
     AND operation.owner_token_sha256 = p_owner_token_sha256
     AND operation.lease_generation = p_lease_generation
   FOR UPDATE;
  IF NOT FOUND OR op.operation_status <> 'RUNNING' OR op.lease_expires_at <= CLOCK_TIMESTAMP() THEN
    RAISE EXCEPTION 'teacher face operation lease is not writable' USING ERRCODE = '55000';
  END IF;
  IF (p_auth_uid IS NOT NULL AND op.auth_uid IS NOT NULL AND op.auth_uid <> p_auth_uid)
     OR (p_auth_owner_token_sha256 IS NOT NULL AND op.auth_owner_token_sha256 IS NOT NULL
       AND op.auth_owner_token_sha256 <> p_auth_owner_token_sha256)
     OR (p_staff_id IS NOT NULL AND op.staff_id IS NOT NULL AND op.staff_id <> p_staff_id)
     OR (p_teacher_id IS NOT NULL AND op.teacher_id IS NOT NULL AND op.teacher_id <> p_teacher_id)
     OR (p_person_id IS NOT NULL AND op.person_id IS NOT NULL AND op.person_id <> p_person_id)
     OR (op.staff_id IS NOT NULL AND (
       op.previous_person_id IS DISTINCT FROM p_previous_person_id
       OR op.previous_photo_reference IS DISTINCT FROM p_previous_photo_reference
       OR op.previous_face_enrollment_status IS DISTINCT FROM p_previous_face_enrollment_status
       OR op.previous_face_consent_at IS DISTINCT FROM NULLIF(p_previous_face_consent_at,'')::timestamptz
       OR op.previous_face_enrolled_at IS DISTINCT FROM NULLIF(p_previous_face_enrolled_at,'')::timestamptz
       OR op.previous_face_enrolled_by_account_id IS DISTINCT FROM p_previous_face_enrolled_by_account_id
     )) THEN
    RAISE EXCEPTION 'teacher face operation binding conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.teacher_face_operations AS target
     SET auth_uid = COALESCE(target.auth_uid, p_auth_uid),
         auth_owner_token_sha256 = COALESCE(target.auth_owner_token_sha256, p_auth_owner_token_sha256),
         staff_id = COALESCE(target.staff_id, p_staff_id),
         teacher_id = COALESCE(target.teacher_id, p_teacher_id),
         person_id = COALESCE(target.person_id, p_person_id),
         previous_person_id = p_previous_person_id,
         previous_photo_reference = p_previous_photo_reference,
         previous_face_enrollment_status = p_previous_face_enrollment_status,
         previous_face_consent_at = NULLIF(p_previous_face_consent_at, '')::timestamptz,
         previous_face_enrolled_at = NULLIF(p_previous_face_enrolled_at, '')::timestamptz,
         previous_face_enrolled_by_account_id = p_previous_face_enrolled_by_account_id,
         updated_at = CLOCK_TIMESTAMP()
   WHERE target.id = op.id;
  RETURN op.id;
END;
$$;

COMMIT;

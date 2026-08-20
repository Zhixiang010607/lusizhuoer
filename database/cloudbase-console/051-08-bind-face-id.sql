-- CloudBase migration 051, part 8 / 10. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.bind_teacher_face_operation_face_id(
  p_operation_id BIGINT, p_owner_token_sha256 VARCHAR,
  p_lease_generation BIGINT, p_group VARCHAR, p_candidate_face_id VARCHAR
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE op public.teacher_face_operations%ROWTYPE;
BEGIN
  IF p_group !~ '^[A-Za-z0-9_-]{1,64}$'
     OR BTRIM(COALESCE(p_candidate_face_id,'')) = '' OR CHAR_LENGTH(p_candidate_face_id) > 128 THEN
    RAISE EXCEPTION 'invalid teacher face candidate FaceId' USING ERRCODE = '22023';
  END IF;
  SELECT operation.* INTO op FROM public.teacher_face_operations AS operation
   WHERE operation.id = p_operation_id
     AND operation.owner_token_sha256 = p_owner_token_sha256
     AND operation.lease_generation = p_lease_generation
   FOR UPDATE;
  IF NOT FOUND OR op.operation_status <> 'RUNNING' OR op.lease_expires_at <= CLOCK_TIMESTAMP()
     OR op.person_id IS NULL OR op.face_group_id <> p_group THEN
    RAISE EXCEPTION 'teacher face operation lease cannot bind FaceId' USING ERRCODE = '55000';
  END IF;
  IF op.candidate_face_id IS NOT NULL AND op.candidate_face_id <> p_candidate_face_id THEN
    RAISE EXCEPTION 'teacher face operation candidate FaceId conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.teacher_face_operations AS target
     SET candidate_face_id = COALESCE(target.candidate_face_id,p_candidate_face_id),
         updated_at = CLOCK_TIMESTAMP()
   WHERE target.id = op.id;
  RETURN op.id;
END;
$$;

COMMIT;

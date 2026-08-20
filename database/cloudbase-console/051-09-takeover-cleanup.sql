-- CloudBase migration 051, part 9 / 10. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.takeover_teacher_face_operation_cleanup(
  p_operation_id BIGINT, p_owner_token_sha256 VARCHAR, p_lease_seconds INTEGER
)
RETURNS TABLE(operation_id BIGINT, operation_status VARCHAR,
              lease_generation BIGINT, lease_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE op public.teacher_face_operations%ROWTYPE; now_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  IF p_owner_token_sha256 !~ '^[a-f0-9]{64}$' OR p_lease_seconds < 300 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'invalid teacher face cleanup takeover' USING ERRCODE = '22023';
  END IF;
  SELECT operation.* INTO op FROM public.teacher_face_operations AS operation
   WHERE operation.id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR op.operation_status NOT IN ('RUNNING','CANCELLED','CLEANUP_PENDING')
     OR op.cleanup_completed_at IS NOT NULL OR op.lease_expires_at > now_value THEN
    RAISE EXCEPTION 'teacher face operation is not eligible for cleanup takeover' USING ERRCODE = '55000';
  END IF;
  UPDATE public.teacher_face_operations AS target
     SET owner_token_sha256 = p_owner_token_sha256,
         lease_generation = target.lease_generation + 1,
         lease_expires_at = now_value + make_interval(secs => p_lease_seconds),
         operation_status = 'CLEANUP_PENDING', cleanup_completed_at = NULL,
         updated_at = now_value
   WHERE target.id = op.id RETURNING target.* INTO op;
  RETURN QUERY SELECT op.id, op.operation_status, op.lease_generation, op.lease_expires_at;
END;
$$;

COMMIT;

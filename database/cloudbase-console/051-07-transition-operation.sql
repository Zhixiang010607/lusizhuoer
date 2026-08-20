-- CloudBase migration 051, part 7 / 10. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.transition_teacher_face_operation(
  p_operation_id BIGINT, p_owner_token_sha256 VARCHAR, p_lease_generation BIGINT,
  p_expected_status VARCHAR, p_new_status VARCHAR,
  p_error_code VARCHAR, p_error_message TEXT, p_cleanup_complete BOOLEAN
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE op public.teacher_face_operations%ROWTYPE; now_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  SELECT operation.* INTO op FROM public.teacher_face_operations AS operation
   WHERE operation.id = p_operation_id
     AND operation.owner_token_sha256 = p_owner_token_sha256
     AND operation.lease_generation = p_lease_generation
   FOR UPDATE;
  IF NOT FOUND OR op.operation_status <> p_expected_status
     OR op.lease_expires_at <= now_value THEN
    RAISE EXCEPTION 'teacher face operation transition lost ownership or status changed' USING ERRCODE = '55000';
  END IF;
  IF NOT ((p_expected_status = 'RUNNING' AND p_new_status IN ('SUCCEEDED','CANCELLED','CLEANUP_PENDING'))
       OR (p_expected_status = 'CANCELLED' AND p_new_status IN ('CANCELLED','CLEANUP_PENDING'))
       OR (p_expected_status = 'CLEANUP_PENDING' AND p_new_status IN ('CANCELLED','CLEANUP_PENDING'))) THEN
    RAISE EXCEPTION 'invalid teacher face operation transition' USING ERRCODE = '22023';
  END IF;
  IF p_cleanup_complete AND p_new_status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'only a cancelled operation can complete cleanup' USING ERRCODE = '22023';
  END IF;
  UPDATE public.teacher_face_operations AS target
     SET operation_status = p_new_status,
         error_code = NULLIF(LEFT(COALESCE(p_error_code,''),100),''),
         error_message = NULLIF(LEFT(COALESCE(p_error_message,''),1000),''),
         succeeded_at = CASE WHEN p_new_status = 'SUCCEEDED' THEN now_value ELSE target.succeeded_at END,
         cancelled_at = CASE WHEN p_new_status IN ('CANCELLED','CLEANUP_PENDING')
                             THEN COALESCE(target.cancelled_at,now_value) ELSE target.cancelled_at END,
         cleanup_completed_at = CASE WHEN p_cleanup_complete THEN now_value ELSE NULL END,
         updated_at = now_value
   WHERE target.id = op.id;
  RETURN op.id;
END;
$$;

COMMIT;

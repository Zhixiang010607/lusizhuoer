-- CloudBase migration 051, part 5 / 10. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.acquire_teacher_face_operation(
  p_type VARCHAR, p_request VARCHAR, p_phone VARCHAR, p_name VARCHAR,
  p_sha VARCHAR, p_bytes INTEGER, p_group VARCHAR, p_bucket VARCHAR, p_actor BIGINT,
  p_owner VARCHAR, p_ttl INTEGER
)
RETURNS TABLE(operation_id BIGINT, acquired BOOLEAN, operation_status VARCHAR,
              lease_generation BIGINT, lease_expires_at TIMESTAMPTZ,
              cleanup_completed_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE o public.teacher_face_operations%ROWTYPE; n TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  PERFORM public.assert_teacher_face_operation_input(
    p_type,p_request,p_phone,p_name,p_sha,p_bytes,p_group,p_bucket,p_actor,p_owner,p_ttl);
  SELECT x.* INTO o FROM public.teacher_face_operations x
   WHERE x.client_request_id=p_request FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.teacher_face_operations
      (operation_type,client_request_id,phone,teacher_name,image_sha256,image_bytes,face_group_id,
       photo_bucket_id,actor_staff_account_id,owner_token_sha256,lease_expires_at)
    VALUES (p_type,p_request,p_phone,p_name,p_sha,p_bytes,p_group,p_bucket,p_actor,p_owner,
            n+make_interval(secs=>p_ttl))
    RETURNING * INTO o;
    RETURN QUERY SELECT o.id,TRUE,o.operation_status,o.lease_generation,
                        o.lease_expires_at,o.cleanup_completed_at;
    RETURN;
  END IF;
  IF o.operation_type<>p_type OR o.phone<>p_phone OR o.teacher_name<>p_name
     OR o.image_sha256<>p_sha OR o.image_bytes<>p_bytes
     OR (o.operation_status<>'SUCCEEDED' AND o.face_group_id<>p_group)
     OR (o.operation_status<>'SUCCEEDED' AND o.photo_bucket_id<>p_bucket)
     OR o.actor_staff_account_id<>p_actor THEN
    RAISE EXCEPTION 'teacher face request mismatch' USING ERRCODE='23505';
  END IF;
  IF o.owner_token_sha256=p_owner
     AND o.operation_status='RUNNING' AND o.lease_expires_at>n THEN
    RETURN QUERY SELECT o.id,TRUE,o.operation_status,o.lease_generation,
                        o.lease_expires_at,o.cleanup_completed_at;
    RETURN;
  END IF;
  IF o.operation_status='SUCCEEDED' THEN
    UPDATE public.teacher_face_operations x SET owner_token_sha256=p_owner,
      lease_generation=x.lease_generation+1,
      lease_expires_at=n+make_interval(secs=>p_ttl),updated_at=n
     WHERE x.id=o.id RETURNING x.* INTO o;
    RETURN QUERY SELECT o.id,TRUE,o.operation_status,o.lease_generation,
                        o.lease_expires_at,o.cleanup_completed_at;
    RETURN;
  END IF;
  IF (o.operation_status='CANCELLED' AND o.cleanup_completed_at IS NOT NULL)
     OR o.lease_expires_at>n THEN
    RETURN QUERY SELECT o.id,FALSE,o.operation_status,o.lease_generation,
                        o.lease_expires_at,o.cleanup_completed_at;
    RETURN;
  END IF;
  UPDATE public.teacher_face_operations x SET owner_token_sha256=p_owner,
    lease_generation=x.lease_generation+1,
    lease_expires_at=n+make_interval(secs=>p_ttl),
    operation_status='CLEANUP_PENDING',cleanup_completed_at=NULL,updated_at=n
   WHERE x.id=o.id RETURNING x.* INTO o;
  RETURN QUERY SELECT o.id,TRUE,o.operation_status,o.lease_generation,
                      o.lease_expires_at,o.cleanup_completed_at;
END;
$$;

COMMIT;

-- CloudBase SQL editor migration 039, part 2 / 5.
BEGIN;

CREATE OR REPLACE FUNCTION public.begin_verification_photo_upload(
  p_request_id VARCHAR, p_verification_id BIGINT, p_photo_slot SMALLINT,
  p_actor_account_id BIGINT, p_bucket_id VARCHAR,
  p_original_object_ref VARCHAR, p_expected_original_bytes INTEGER,
  p_ttl_seconds INTEGER
)
RETURNS TABLE(
  request_id VARCHAR, request_status VARCHAR, photo_slot SMALLINT,
  bucket_id VARCHAR, original_object_ref VARCHAR,
  expected_original_bytes INTEGER, expires_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
  created_now BOOLEAN, request_matches BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  order_submitter BIGINT;
  order_submitted_at TIMESTAMPTZ;
  existing_request public.verification_photo_upload_requests%ROWTYPE;
  active_request public.verification_photo_upload_requests%ROWTYPE;
  saved_request public.verification_photo_upload_requests%ROWTYPE;
BEGIN
  IF p_photo_slot NOT BETWEEN 2 AND 4 THEN
    RAISE EXCEPTION 'only supplemental photo slots 2 through 4 are writable'
      USING ERRCODE = '22023';
  END IF;
  IF p_expected_original_bytes NOT BETWEEN 4 AND 3145728 THEN
    RAISE EXCEPTION 'direct upload size is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds NOT BETWEEN 120 AND 900 THEN
    RAISE EXCEPTION 'direct upload ttl is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$' THEN
    RAISE EXCEPTION 'direct upload request id is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT v.submitted_by_account_id, v.submitted_at
    INTO order_submitter, order_submitted_at
    FROM public.verification_records AS v
   WHERE v.id = p_verification_id
   FOR UPDATE;
  IF order_submitter IS NULL THEN
    RAISE EXCEPTION 'verification order does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF order_submitter <> p_actor_account_id THEN
    RAISE EXCEPTION 'only the verification submitter may upload photo evidence'
      USING ERRCODE = '42501';
  END IF;
  IF CLOCK_TIMESTAMP() >= order_submitted_at + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'the verification photo upload window has expired'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.verification_photo_upload_requests AS upload_request
     SET status = 'EXPIRED', updated_at = NOW()
   WHERE upload_request.verification_id = p_verification_id
     AND upload_request.status = 'UPLOADING'
     AND upload_request.expires_at <= CLOCK_TIMESTAMP();

  SELECT upload_request.* INTO existing_request
    FROM public.verification_photo_upload_requests AS upload_request
   WHERE upload_request.request_id = p_request_id
   FOR UPDATE;
  IF existing_request.request_id IS NOT NULL THEN
    IF existing_request.verification_id <> p_verification_id
       OR existing_request.photo_slot <> p_photo_slot
       OR existing_request.actor_account_id <> p_actor_account_id
       OR existing_request.expected_original_bytes <> p_expected_original_bytes THEN
      RAISE EXCEPTION 'request id belongs to a different photo upload'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT
      existing_request.request_id, existing_request.status,
      existing_request.photo_slot, existing_request.bucket_id,
      existing_request.original_object_ref,
      existing_request.expected_original_bytes, existing_request.expires_at,
      existing_request.committed_at, existing_request.cancelled_at,
      FALSE, TRUE;
    RETURN;
  END IF;

  SELECT upload_request.* INTO active_request
    FROM public.verification_photo_upload_requests AS upload_request
   WHERE upload_request.verification_id = p_verification_id
     AND upload_request.status = 'UPLOADING'
   LIMIT 1 FOR UPDATE;
  IF active_request.request_id IS NOT NULL THEN
    RETURN QUERY SELECT
      active_request.request_id, active_request.status,
      active_request.photo_slot, active_request.bucket_id,
      active_request.original_object_ref,
      active_request.expected_original_bytes, active_request.expires_at,
      active_request.committed_at, active_request.cancelled_at,
      FALSE, FALSE;
    RETURN;
  END IF;

  IF (
    SELECT COUNT(*) FROM public.verification_photo_upload_requests AS recent_request
     WHERE recent_request.verification_id = p_verification_id
       AND recent_request.actor_account_id = p_actor_account_id
       AND recent_request.created_at >= CLOCK_TIMESTAMP() - INTERVAL '1 hour'
  ) >= 30 THEN
    RAISE EXCEPTION 'PHOTO_UPLOAD_RATE_LIMITED: too many upload requests for this order'
      USING ERRCODE = '54000';
  END IF;

  IF BTRIM(COALESCE(p_bucket_id, '')) = ''
     OR p_original_object_ref NOT LIKE
       ('pg://' || p_bucket_id || '/records/' || p_verification_id::TEXT
        || '/slot-' || p_photo_slot::TEXT || '/direct-%.jpg') THEN
    RAISE EXCEPTION 'server-generated photo object reference is invalid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.verification_photo_upload_requests
    (request_id, verification_id, photo_slot, actor_account_id, status,
     bucket_id, original_object_ref, expected_original_bytes, expires_at,
     cleanup_after)
  VALUES
    (p_request_id, p_verification_id, p_photo_slot, p_actor_account_id,
     'UPLOADING', p_bucket_id, p_original_object_ref,
     p_expected_original_bytes,
     LEAST(CLOCK_TIMESTAMP() + (p_ttl_seconds * INTERVAL '1 second'),
           order_submitted_at + INTERVAL '24 hours'),
     CLOCK_TIMESTAMP() + INTERVAL '3 hours')
  RETURNING * INTO saved_request;

  RETURN QUERY SELECT
    saved_request.request_id, saved_request.status,
    saved_request.photo_slot, saved_request.bucket_id,
    saved_request.original_object_ref, saved_request.expected_original_bytes,
    saved_request.expires_at, saved_request.committed_at,
    saved_request.cancelled_at, TRUE, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_verification_photo_upload(
  VARCHAR, BIGINT, SMALLINT, BIGINT, VARCHAR, VARCHAR, INTEGER, INTEGER
) FROM PUBLIC;

COMMIT;

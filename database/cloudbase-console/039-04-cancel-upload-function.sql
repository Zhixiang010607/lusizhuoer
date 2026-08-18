-- CloudBase SQL editor migration 039, part 4 / 5.
BEGIN;

CREATE OR REPLACE FUNCTION public.cancel_verification_photo_upload(
  p_request_id VARCHAR, p_verification_id BIGINT,
  p_actor_account_id BIGINT
)
RETURNS TABLE(
  request_id VARCHAR, request_status VARCHAR, photo_slot SMALLINT,
  expected_original_bytes INTEGER, expires_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
  cancelled_now BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  order_submitter BIGINT;
  upload_request public.verification_photo_upload_requests%ROWTYPE;
  did_cancel BOOLEAN := FALSE;
BEGIN
  SELECT v.submitted_by_account_id INTO order_submitter
    FROM public.verification_records AS v
   WHERE v.id = p_verification_id
   FOR UPDATE;
  IF order_submitter IS NULL THEN
    RAISE EXCEPTION 'verification order does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF order_submitter <> p_actor_account_id THEN
    RAISE EXCEPTION 'only the verification submitter may cancel photo uploads'
      USING ERRCODE = '42501';
  END IF;

  SELECT pending.* INTO upload_request
    FROM public.verification_photo_upload_requests AS pending
   WHERE pending.request_id = p_request_id
   FOR UPDATE;
  IF upload_request.request_id IS NULL
     OR upload_request.verification_id <> p_verification_id
     OR upload_request.actor_account_id <> p_actor_account_id THEN
    RAISE EXCEPTION 'direct upload request does not exist' USING ERRCODE = 'P0002';
  END IF;

  IF upload_request.status = 'UPLOADING' THEN
    IF upload_request.expires_at <= CLOCK_TIMESTAMP() THEN
      UPDATE public.verification_photo_upload_requests AS pending
         SET status = 'EXPIRED', updated_at = NOW()
       WHERE pending.request_id = p_request_id
       RETURNING * INTO upload_request;
    ELSE
      UPDATE public.verification_photo_upload_requests AS pending
         SET status = 'CANCELLED', cancelled_at = NOW(), updated_at = NOW()
       WHERE pending.request_id = p_request_id
       RETURNING * INTO upload_request;
      did_cancel := TRUE;
    END IF;
  END IF;

  RETURN QUERY SELECT
    upload_request.request_id, upload_request.status,
    upload_request.photo_slot, upload_request.expected_original_bytes,
    upload_request.expires_at, upload_request.committed_at,
    upload_request.cancelled_at, did_cancel;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_verification_photo_upload(
  VARCHAR, BIGINT, BIGINT
) FROM PUBLIC;

COMMENT ON TABLE public.verification_photo_upload_requests IS
  'Migration 039: short-lived, single-active direct upload intents for verification supplemental photos.';
COMMENT ON FUNCTION public.begin_verification_photo_upload(
  VARCHAR, BIGINT, SMALLINT, BIGINT, VARCHAR, VARCHAR, INTEGER, INTEGER
) IS 'Migration 039: idempotently reserves one server-generated upload object per verification order.';
COMMENT ON FUNCTION public.commit_verification_photo_upload(
  VARCHAR, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, CHAR
) IS 'Migration 039: atomically binds a server-inspected JPEG and closes its upload intent.';

COMMIT;

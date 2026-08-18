-- CloudBase SQL editor migration 039, part 3 / 5.
BEGIN;

CREATE OR REPLACE FUNCTION public.commit_verification_photo_upload(
  p_request_id VARCHAR, p_verification_id BIGINT,
  p_actor_account_id BIGINT, p_actual_original_bytes INTEGER,
  p_image_width INTEGER, p_image_height INTEGER, p_sha256 CHAR(64)
)
RETURNS TABLE(
  request_id VARCHAR, request_status VARCHAR, photo_slot SMALLINT,
  committed_now BOOLEAN, old_original_object_ref TEXT,
  old_thumbnail_object_ref TEXT, photo_id BIGINT, original_bytes INTEGER,
  image_width INTEGER, image_height INTEGER, sha256 CHAR(64),
  uploaded_at TIMESTAMPTZ, committed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  order_submitter BIGINT;
  order_submitted_at TIMESTAMPTZ;
  upload_request public.verification_photo_upload_requests%ROWTYPE;
  saved_photo public.verification_photos%ROWTYPE;
  old_original TEXT;
  old_thumbnail TEXT;
BEGIN
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

  SELECT pending.* INTO upload_request
    FROM public.verification_photo_upload_requests AS pending
   WHERE pending.request_id = p_request_id
   FOR UPDATE;
  IF upload_request.request_id IS NULL
     OR upload_request.verification_id <> p_verification_id
     OR upload_request.actor_account_id <> p_actor_account_id THEN
    RAISE EXCEPTION 'direct upload request does not exist' USING ERRCODE = 'P0002';
  END IF;

  IF upload_request.status = 'COMMITTED' THEN
    SELECT photo.* INTO saved_photo
      FROM public.verification_photos AS photo
     WHERE photo.verification_id = p_verification_id
       AND photo.photo_slot = upload_request.photo_slot
       AND photo.original_object_ref = upload_request.original_object_ref
     LIMIT 1;
    RETURN QUERY SELECT
      upload_request.request_id, upload_request.status,
      upload_request.photo_slot, FALSE, NULL::TEXT, NULL::TEXT,
      saved_photo.id, upload_request.actual_original_bytes,
      upload_request.image_width, upload_request.image_height,
      upload_request.sha256, upload_request.committed_at,
      upload_request.committed_at;
    RETURN;
  END IF;

  IF upload_request.status IN ('CANCELLED', 'EXPIRED') THEN
    RETURN QUERY SELECT
      upload_request.request_id, upload_request.status,
      upload_request.photo_slot, FALSE, NULL::TEXT, NULL::TEXT,
      NULL::BIGINT, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER,
      NULL::CHAR(64), NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF upload_request.expires_at <= CLOCK_TIMESTAMP()
     OR CLOCK_TIMESTAMP() >= order_submitted_at + INTERVAL '24 hours' THEN
    UPDATE public.verification_photo_upload_requests AS pending
       SET status = 'EXPIRED', updated_at = NOW()
     WHERE pending.request_id = p_request_id
     RETURNING * INTO upload_request;
    RETURN QUERY SELECT
      upload_request.request_id, upload_request.status,
      upload_request.photo_slot, FALSE, NULL::TEXT, NULL::TEXT,
      NULL::BIGINT, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER,
      NULL::CHAR(64), NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_actual_original_bytes IS NULL
     OR p_image_width IS NULL OR p_image_height IS NULL OR p_sha256 IS NULL
     OR p_actual_original_bytes <> upload_request.expected_original_bytes
     OR p_actual_original_bytes NOT BETWEEN 4 AND 3145728
     OR p_image_width NOT BETWEEN 1 AND 10000
     OR p_image_height NOT BETWEEN 1 AND 10000
     OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'verified direct upload metadata is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT photo.original_object_ref, photo.thumbnail_object_ref
    INTO old_original, old_thumbnail
    FROM public.verification_photos AS photo
   WHERE photo.verification_id = p_verification_id
     AND photo.photo_slot = upload_request.photo_slot
   FOR UPDATE;

  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref,
     thumbnail_object_ref, original_bytes, thumbnail_bytes,
     image_width, image_height, sha256, uploaded_by_account_id)
  VALUES
    (p_verification_id, upload_request.photo_slot, 'EXTRA',
     upload_request.original_object_ref, upload_request.original_object_ref,
     p_actual_original_bytes, NULL, p_image_width, p_image_height,
     p_sha256, p_actor_account_id)
  ON CONFLICT (verification_id, photo_slot) DO UPDATE
     SET original_object_ref = EXCLUDED.original_object_ref,
         thumbnail_object_ref = EXCLUDED.thumbnail_object_ref,
         original_bytes = EXCLUDED.original_bytes,
         thumbnail_bytes = EXCLUDED.thumbnail_bytes,
         image_width = EXCLUDED.image_width,
         image_height = EXCLUDED.image_height,
         sha256 = EXCLUDED.sha256,
         updated_at = NOW()
  RETURNING * INTO saved_photo;

  INSERT INTO public.verification_photo_events
    (verification_id, photo_slot, event_type, actor_account_id)
  VALUES
    (p_verification_id, upload_request.photo_slot,
     CASE WHEN old_original IS NULL THEN 'UPLOAD' ELSE 'REPLACE' END,
     p_actor_account_id);

  UPDATE public.verification_photo_upload_requests AS pending
     SET status = 'COMMITTED',
         actual_original_bytes = p_actual_original_bytes,
         image_width = p_image_width, image_height = p_image_height,
         sha256 = p_sha256, committed_at = NOW(), updated_at = NOW()
   WHERE pending.request_id = p_request_id
   RETURNING * INTO upload_request;

  RETURN QUERY SELECT
    upload_request.request_id, upload_request.status,
    upload_request.photo_slot, TRUE, old_original, old_thumbnail,
    saved_photo.id, saved_photo.original_bytes,
    saved_photo.image_width, saved_photo.image_height, saved_photo.sha256,
    saved_photo.updated_at, upload_request.committed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_verification_photo_upload(
  VARCHAR, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, CHAR
) FROM PUBLIC;

COMMIT;

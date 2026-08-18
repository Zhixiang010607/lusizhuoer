-- CloudBase SQL editor migration 037, part 3 / 3.
-- Create the supplemental-photo function, revoke public access and add comments.
-- Run this file by itself. Continue only after COMMIT succeeds.
-- After pasting, press Ctrl+A in the editor so the entire short file is selected.
-- If the editor is already in an aborted transaction, run ROLLBACK;
-- separately before running this file. Do not prepend ROLLBACK here.
BEGIN;
CREATE OR REPLACE FUNCTION public.upsert_verification_extra_photo(
  p_verification_id BIGINT,
  p_photo_slot SMALLINT,
  p_actor_account_id BIGINT,
  p_original_object_ref VARCHAR,
  p_thumbnail_object_ref VARCHAR,
  p_original_bytes INTEGER,
  p_thumbnail_bytes INTEGER,
  p_image_width INTEGER,
  p_image_height INTEGER,
  p_sha256 CHAR(64)
)
RETURNS TABLE(
  photo_id BIGINT,
  old_original_object_ref TEXT,
  old_thumbnail_object_ref TEXT,
  uploaded_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  order_submitter BIGINT;
  order_submitted_at TIMESTAMPTZ;
  old_original TEXT;
  old_thumbnail TEXT;
  saved public.verification_photos%ROWTYPE;
BEGIN
  IF p_photo_slot NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'only supplemental photo slots 1 through 3 are writable'
      USING ERRCODE = '22023';
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

  SELECT photo.original_object_ref, photo.thumbnail_object_ref
    INTO old_original, old_thumbnail
    FROM public.verification_photos AS photo
   WHERE photo.verification_id = p_verification_id
     AND photo.photo_slot = p_photo_slot
   FOR UPDATE;

  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref,
     thumbnail_object_ref, original_bytes, thumbnail_bytes,
     image_width, image_height, sha256, uploaded_by_account_id)
  VALUES
    (p_verification_id, p_photo_slot, 'EXTRA', p_original_object_ref,
     p_thumbnail_object_ref, p_original_bytes, p_thumbnail_bytes,
     p_image_width, p_image_height, p_sha256, p_actor_account_id)
  ON CONFLICT (verification_id, photo_slot) DO UPDATE
     SET original_object_ref = EXCLUDED.original_object_ref,
         thumbnail_object_ref = EXCLUDED.thumbnail_object_ref,
         original_bytes = EXCLUDED.original_bytes,
         thumbnail_bytes = EXCLUDED.thumbnail_bytes,
         image_width = EXCLUDED.image_width,
         image_height = EXCLUDED.image_height,
         sha256 = EXCLUDED.sha256,
         updated_at = NOW()
  RETURNING * INTO saved;

  INSERT INTO public.verification_photo_events
    (verification_id, photo_slot, event_type, actor_account_id)
  VALUES
    (p_verification_id, p_photo_slot,
     CASE WHEN old_original IS NULL THEN 'UPLOAD' ELSE 'REPLACE' END,
     p_actor_account_id);

  RETURN QUERY SELECT saved.id, old_original, old_thumbnail, saved.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, BIGINT, TEXT, TEXT,
  VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_verification_extra_photo(
  BIGINT, SMALLINT, BIGINT, VARCHAR, VARCHAR, INTEGER, INTEGER, INTEGER,
  INTEGER, CHAR
) FROM PUBLIC;

COMMENT ON TABLE public.verification_photos IS
  'Migration 037: immutable face photo plus three supplemental slots.';
COMMENT ON TABLE public.verification_photo_drafts IS
  'Migration 037: temporary face photos awaiting atomic order attachment.';
COMMENT ON TABLE public.verification_photo_events IS
  'Migration 037: append-only verification photo audit.';
COMMENT ON FUNCTION public.enforce_verification_photo_write() IS
  'Migration 037: immutable face photo; extras limited to submitter and 24 hours.';

COMMIT;

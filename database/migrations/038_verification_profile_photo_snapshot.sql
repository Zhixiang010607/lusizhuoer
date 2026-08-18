-- Execute this entire file only after migration 037 has committed. If a
-- previous partial attempt failed, run ROLLBACK in a separate query first.
BEGIN;

-- Run after migration 037.  This expands each verification order from four
-- photo positions to five: the customer's retained enrollment photo, the
-- immutable face-verification capture, and three supplemental positions.
DO $$
BEGIN
  IF TO_REGCLASS('public.verification_photos') IS NULL
     OR TO_REGPROCEDURE(
       'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
     ) IS NULL THEN
    RAISE EXCEPTION 'migration 037 must be executed before migration 038';
  END IF;
END;
$$;

ALTER TABLE public.verification_photos
  DROP CONSTRAINT IF EXISTS verification_photos_photo_slot_check,
  DROP CONSTRAINT IF EXISTS verification_photos_photo_kind_check,
  DROP CONSTRAINT IF EXISTS verification_photos_check,
  DROP CONSTRAINT IF EXISTS verification_photos_original_bytes_check,
  DROP CONSTRAINT IF EXISTS verification_photos_thumbnail_bytes_check,
  DROP CONSTRAINT IF EXISTS verification_photos_image_width_check,
  DROP CONSTRAINT IF EXISTS verification_photos_image_height_check,
  DROP CONSTRAINT IF EXISTS verification_photos_sha256_check;

ALTER TABLE public.verification_photo_events
  DROP CONSTRAINT IF EXISTS verification_photo_events_photo_slot_check,
  DROP CONSTRAINT IF EXISTS verification_photo_events_event_type_check;

DROP TRIGGER IF EXISTS trg_enforce_verification_photo_write
  ON public.verification_photos;

ALTER TABLE public.verification_photos
  ALTER COLUMN original_bytes DROP NOT NULL,
  ALTER COLUMN thumbnail_bytes DROP NOT NULL,
  ALTER COLUMN image_width DROP NOT NULL,
  ALTER COLUMN image_height DROP NOT NULL,
  ALTER COLUMN sha256 DROP NOT NULL;

-- If v43 briefly created four-slot orders before this migration, shift those
-- historical positions upward without overwriting a neighbouring slot.
UPDATE public.verification_photos SET photo_slot = 4 WHERE photo_slot = 3;
UPDATE public.verification_photos SET photo_slot = 3 WHERE photo_slot = 2;
UPDATE public.verification_photos SET photo_slot = 2 WHERE photo_slot = 1;
UPDATE public.verification_photos SET photo_slot = 1 WHERE photo_slot = 0;

UPDATE public.verification_photo_events
   SET photo_slot = photo_slot + 1
 WHERE photo_slot BETWEEN 0 AND 3;

-- The retained profile object reference is snapshotted from the customer row.
-- Application code never grants the browser direct access to this reference.
WITH inserted_profiles AS (
  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref,
     thumbnail_object_ref, original_bytes, thumbnail_bytes,
     image_width, image_height, sha256, uploaded_by_account_id,
     source_evidence_token)
  SELECT v.id, 0, 'PROFILE', c.profile_photo_file_id,
         c.profile_photo_file_id, NULL, NULL, NULL, NULL, NULL,
         v.submitted_by_account_id, NULL
    FROM public.verification_records AS v
    JOIN public.customers AS c ON c.id = v.customer_id
   WHERE BTRIM(COALESCE(c.profile_photo_file_id, '')) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.verification_photos AS p
        WHERE p.verification_id = v.id AND p.photo_slot = 0
     )
  RETURNING verification_id, uploaded_by_account_id
)
INSERT INTO public.verification_photo_events
  (verification_id, photo_slot, event_type, actor_account_id)
SELECT verification_id, 0, 'PROFILE_BOUND', uploaded_by_account_id
  FROM inserted_profiles;

ALTER TABLE public.verification_photos
  ADD CONSTRAINT verification_photos_slot_v38_check
    CHECK (photo_slot BETWEEN 0 AND 4),
  ADD CONSTRAINT verification_photos_kind_v38_check
    CHECK (photo_kind IN ('PROFILE', 'FACE', 'EXTRA')),
  ADD CONSTRAINT verification_photos_slot_kind_v38_check
    CHECK (
      (photo_slot = 0 AND photo_kind = 'PROFILE' AND source_evidence_token IS NULL)
      OR (photo_slot = 1 AND photo_kind = 'FACE' AND source_evidence_token IS NOT NULL)
      OR (photo_slot BETWEEN 2 AND 4 AND photo_kind = 'EXTRA' AND source_evidence_token IS NULL)
    ),
  ADD CONSTRAINT verification_photos_metadata_v38_check
    CHECK (
      (photo_kind = 'PROFILE'
       AND original_bytes IS NULL AND thumbnail_bytes IS NULL
       AND image_width IS NULL AND image_height IS NULL AND sha256 IS NULL)
      OR
      (photo_kind IN ('FACE', 'EXTRA')
       AND original_bytes BETWEEN 1 AND 3145728
       AND thumbnail_bytes BETWEEN 1 AND 393216
       AND image_width BETWEEN 1 AND 10000
       AND image_height BETWEEN 1 AND 10000
       AND sha256 ~ '^[0-9a-f]{64}$')
    );

ALTER TABLE public.verification_photo_events
  ADD CONSTRAINT verification_photo_events_slot_v38_check
    CHECK (photo_slot BETWEEN 0 AND 4),
  ADD CONSTRAINT verification_photo_events_type_v38_check
    CHECK (event_type IN ('PROFILE_BOUND', 'FACE_BOUND', 'UPLOAD', 'REPLACE', 'VIEW_ORIGINAL'));

CREATE OR REPLACE FUNCTION public.enforce_verification_photo_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_submitter BIGINT;
  order_submitted_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verification photo evidence cannot be deleted'
      USING ERRCODE = '42501';
  END IF;

  SELECT v.submitted_by_account_id, v.submitted_at
    INTO order_submitter, order_submitted_at
    FROM public.verification_records AS v
   WHERE v.id = NEW.verification_id
   FOR UPDATE;

  IF order_submitter IS NULL THEN
    RAISE EXCEPTION 'verification order does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF NEW.uploaded_by_account_id <> order_submitter THEN
    RAISE EXCEPTION 'only the verification submitter may upload photo evidence'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.photo_slot IN (0, 1) THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'retained profile and face-verification photos are immutable'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF CLOCK_TIMESTAMP() >= order_submitted_at + INTERVAL '24 hours' THEN
      RAISE EXCEPTION 'the verification photo upload window has expired'
        USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      NEW.verification_id <> OLD.verification_id
      OR NEW.photo_slot <> OLD.photo_slot
      OR NEW.uploaded_by_account_id <> OLD.uploaded_by_account_id
      OR NEW.created_at <> OLD.created_at
    ) THEN
      RAISE EXCEPTION 'verification photo ownership fields are immutable'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_verification_photo_write
BEFORE INSERT OR UPDATE OR DELETE ON public.verification_photos
FOR EACH ROW EXECUTE FUNCTION public.enforce_verification_photo_write();

CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo(
  p_verification_type VARCHAR,
  p_store_id BIGINT,
  p_teacher_id BIGINT,
  p_customer_id BIGINT,
  p_product_id BIGINT,
  p_record_status VARCHAR,
  p_submitted_by_account_id BIGINT,
  p_message TEXT,
  p_supplement_note TEXT,
  p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR,
  p_idempotency_key VARCHAR
)
RETURNS TABLE(
  id BIGINT,
  verification_code TEXT,
  verification_type TEXT,
  store_id BIGINT,
  teacher_id BIGINT,
  customer_id BIGINT,
  product_id BIGINT,
  unit_count INTEGER,
  record_status TEXT,
  submitted_by_account_id BIGINT,
  submitted_at TIMESTAMPTZ,
  message TEXT,
  supplement_note TEXT,
  face_request_id TEXT,
  idempotency_key TEXT,
  created_now BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  existing_record public.verification_records%ROWTYPE;
  draft public.verification_photo_drafts%ROWTYPE;
  created_record public.verification_records%ROWTYPE;
  profile_object_ref TEXT;
  normalized_type TEXT := UPPER(BTRIM(COALESCE(p_verification_type, '')));
  normalized_status TEXT := UPPER(BTRIM(COALESCE(p_record_status, '')));
BEGIN
  IF normalized_type NOT IN ('NORMAL', 'SUPPLEMENT') THEN
    RAISE EXCEPTION 'unsupported verification type' USING ERRCODE = '22023';
  END IF;
  IF normalized_status <> CASE WHEN normalized_type = 'NORMAL' THEN 'APPROVED' ELSE 'PENDING' END THEN
    RAISE EXCEPTION 'verification status does not match verification type'
      USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_face_evidence_token, '')) = '' THEN
    RAISE EXCEPTION 'face photo evidence is required' USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_face_request_id, '')) = '' THEN
    RAISE EXCEPTION 'face verification request id is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));

  SELECT v.*
    INTO existing_record
    FROM public.verification_records AS v
   WHERE v.idempotency_key = p_idempotency_key
   LIMIT 1;

  IF existing_record.id IS NOT NULL THEN
    IF existing_record.verification_type <> normalized_type
       OR existing_record.store_id <> p_store_id
       OR existing_record.teacher_id <> p_teacher_id
       OR existing_record.customer_id <> p_customer_id
       OR existing_record.product_id <> p_product_id
       OR existing_record.submitted_by_account_id <> p_submitted_by_account_id
       OR existing_record.message <> COALESCE(p_message, '')
       OR existing_record.supplement_note <> COALESCE(p_supplement_note, '')
       OR existing_record.face_request_id <> p_face_request_id
       OR NOT EXISTS (
         SELECT 1 FROM public.verification_photos AS photo
          WHERE photo.verification_id = existing_record.id
            AND photo.photo_slot = 0 AND photo.photo_kind = 'PROFILE'
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.verification_photos AS photo
          WHERE photo.verification_id = existing_record.id
            AND photo.photo_slot = 1 AND photo.photo_kind = 'FACE'
            AND photo.source_evidence_token = p_face_evidence_token
       ) THEN
      RAISE EXCEPTION 'idempotency key belongs to a different verification request'
        USING ERRCODE = '23505';
    END IF;

    RETURN QUERY SELECT
      existing_record.id, existing_record.verification_code::TEXT,
      existing_record.verification_type::TEXT, existing_record.store_id,
      existing_record.teacher_id, existing_record.customer_id,
      existing_record.product_id, existing_record.unit_count,
      existing_record.record_status::TEXT, existing_record.submitted_by_account_id,
      existing_record.submitted_at, existing_record.message,
      existing_record.supplement_note, existing_record.face_request_id::TEXT,
      existing_record.idempotency_key::TEXT, FALSE;
    RETURN;
  END IF;

  SELECT d.*
    INTO draft
    FROM public.verification_photo_drafts AS d
   WHERE d.evidence_token = p_face_evidence_token
     AND d.store_id = p_store_id
     AND d.customer_id = p_customer_id
     AND d.submitted_by_account_id = p_submitted_by_account_id
     AND d.face_request_id = p_face_request_id
     AND d.consumed_at IS NULL
     AND d.expires_at > CLOCK_TIMESTAMP()
   FOR UPDATE;

  IF draft.evidence_token IS NULL THEN
    RAISE EXCEPTION 'face photo evidence is missing, expired, consumed, or belongs to another request'
      USING ERRCODE = '42501';
  END IF;

  SELECT c.profile_photo_file_id
    INTO profile_object_ref
    FROM public.customers AS c
   WHERE c.id = p_customer_id
     AND c.created_store_id = p_store_id
     AND c.customer_status = 'ACTIVE'
   FOR SHARE;

  IF BTRIM(COALESCE(profile_object_ref, '')) = '' THEN
    RAISE EXCEPTION 'customer retained profile photo is required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.verification_records
    (verification_type, store_id, teacher_id, customer_id, product_id,
     unit_count, record_status, submitted_by_account_id, message,
     supplement_note, face_request_id, idempotency_key)
  VALUES
    (normalized_type, p_store_id, p_teacher_id, p_customer_id, p_product_id,
     1, normalized_status, p_submitted_by_account_id, COALESCE(p_message, ''),
     COALESCE(p_supplement_note, ''), p_face_request_id, p_idempotency_key)
  RETURNING * INTO created_record;

  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref,
     thumbnail_object_ref, original_bytes, thumbnail_bytes,
     image_width, image_height, sha256, uploaded_by_account_id,
     source_evidence_token)
  VALUES
    (created_record.id, 0, 'PROFILE', profile_object_ref,
     profile_object_ref, NULL, NULL, NULL, NULL, NULL,
     p_submitted_by_account_id, NULL),
    (created_record.id, 1, 'FACE', draft.original_object_ref,
     draft.thumbnail_object_ref, draft.original_bytes, draft.thumbnail_bytes,
     draft.image_width, draft.image_height, draft.sha256,
     p_submitted_by_account_id, draft.evidence_token);

  INSERT INTO public.verification_photo_events
    (verification_id, photo_slot, event_type, actor_account_id)
  VALUES
    (created_record.id, 0, 'PROFILE_BOUND', p_submitted_by_account_id),
    (created_record.id, 1, 'FACE_BOUND', p_submitted_by_account_id);

  UPDATE public.verification_photo_drafts
     SET consumed_by_verification_id = created_record.id,
         consumed_at = NOW()
   WHERE evidence_token = draft.evidence_token;

  RETURN QUERY SELECT
    created_record.id, created_record.verification_code::TEXT,
    created_record.verification_type::TEXT, created_record.store_id,
    created_record.teacher_id, created_record.customer_id,
    created_record.product_id, created_record.unit_count,
    created_record.record_status::TEXT, created_record.submitted_by_account_id,
    created_record.submitted_at, created_record.message,
    created_record.supplement_note, created_record.face_request_id::TEXT,
    created_record.idempotency_key::TEXT, TRUE;
END;
$$;

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
  IF p_photo_slot NOT BETWEEN 2 AND 4 THEN
    RAISE EXCEPTION 'only supplemental photo slots 2 through 4 are writable'
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
  'Migration 038: retained profile snapshot, immutable face capture, and three submitter-managed supplemental slots.';
COMMENT ON FUNCTION public.enforce_verification_photo_write() IS
  'Migration 038: profile and face photos immutable; supplemental slots 2-4 writable only by the submitter for 24 hours.';

COMMIT;

-- Execute this entire file at once. If a previous pasted/partial attempt ended
-- with SQLSTATE 42601, run ROLLBACK in a separate query before retrying.
-- Tencent CloudBase ExecutePGSql editor users must instead run the shorter
-- database/cloudbase-console/037-01 through 037-03 files in order.
BEGIN;

-- Verification photo evidence is stored as private CloudBase Storage objects.
-- PostgreSQL stores only immutable object references and authorization metadata.
-- Run after migrations 026 and 036.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'verification_records'
       AND column_name = 'idempotency_key'
  ) THEN
    RAISE EXCEPTION 'migration 026 must be executed before migration 037';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.verification_photo_drafts (
  evidence_token VARCHAR(64) PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  submitted_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  face_request_id VARCHAR(128) NOT NULL,
  original_object_ref VARCHAR(768) NOT NULL,
  thumbnail_object_ref VARCHAR(768) NOT NULL,
  original_bytes INTEGER NOT NULL CHECK (original_bytes BETWEEN 1 AND 3145728),
  thumbnail_bytes INTEGER NOT NULL CHECK (thumbnail_bytes BETWEEN 1 AND 393216),
  image_width INTEGER NOT NULL CHECK (image_width BETWEEN 1 AND 10000),
  image_height INTEGER NOT NULL CHECK (image_height BETWEEN 1 AND 10000),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_by_verification_id BIGINT REFERENCES public.verification_records(id),
  consumed_at TIMESTAMPTZ,
  CHECK (BTRIM(evidence_token) <> ''),
  CHECK (BTRIM(face_request_id) <> ''),
  CHECK (BTRIM(original_object_ref) <> ''),
  CHECK (BTRIM(thumbnail_object_ref) <> ''),
  CHECK (
    (consumed_by_verification_id IS NULL AND consumed_at IS NULL)
    OR (consumed_by_verification_id IS NOT NULL AND consumed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_verification_photo_drafts_expiry
  ON public.verification_photo_drafts (expires_at, evidence_token)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_verification_photo_drafts_submitter
  ON public.verification_photo_drafts
    (submitted_by_account_id, store_id, customer_id, created_at DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.verification_photos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verification_id BIGINT NOT NULL REFERENCES public.verification_records(id),
  photo_slot SMALLINT NOT NULL CHECK (photo_slot BETWEEN 0 AND 3),
  photo_kind VARCHAR(16) NOT NULL CHECK (photo_kind IN ('FACE', 'EXTRA')),
  original_object_ref VARCHAR(768) NOT NULL,
  thumbnail_object_ref VARCHAR(768) NOT NULL,
  original_bytes INTEGER NOT NULL CHECK (original_bytes BETWEEN 1 AND 3145728),
  thumbnail_bytes INTEGER NOT NULL CHECK (thumbnail_bytes BETWEEN 1 AND 393216),
  image_width INTEGER NOT NULL CHECK (image_width BETWEEN 1 AND 10000),
  image_height INTEGER NOT NULL CHECK (image_height BETWEEN 1 AND 10000),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  source_evidence_token VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (verification_id, photo_slot),
  UNIQUE (source_evidence_token),
  CHECK (BTRIM(original_object_ref) <> ''),
  CHECK (BTRIM(thumbnail_object_ref) <> ''),
  CHECK (
    (photo_slot = 0 AND photo_kind = 'FACE' AND source_evidence_token IS NOT NULL)
    OR (photo_slot BETWEEN 1 AND 3 AND photo_kind = 'EXTRA' AND source_evidence_token IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_verification_photos_verification
  ON public.verification_photos (verification_id, photo_slot);

CREATE TABLE IF NOT EXISTS public.verification_photo_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verification_id BIGINT NOT NULL REFERENCES public.verification_records(id),
  photo_slot SMALLINT NOT NULL CHECK (photo_slot BETWEEN 0 AND 3),
  event_type VARCHAR(24) NOT NULL
    CHECK (event_type IN ('FACE_BOUND', 'UPLOAD', 'REPLACE', 'VIEW_ORIGINAL')),
  actor_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_photo_events_record_time
  ON public.verification_photo_events (verification_id, event_at DESC, id DESC);

ALTER TABLE public.verification_photo_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_photo_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.verification_photo_drafts FROM PUBLIC;
REVOKE ALL ON TABLE public.verification_photos FROM PUBLIC;
REVOKE ALL ON TABLE public.verification_photo_events FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.verification_photo_drafts FROM authenticated;
    REVOKE ALL ON TABLE public.verification_photos FROM authenticated;
    REVOKE ALL ON TABLE public.verification_photo_events FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.verification_photo_drafts FROM anon;
    REVOKE ALL ON TABLE public.verification_photos FROM anon;
    REVOKE ALL ON TABLE public.verification_photo_events FROM anon;
  END IF;
END;
$$;

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

  IF NEW.photo_slot = 0 THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'the face-verification photo is immutable'
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

DROP TRIGGER IF EXISTS trg_enforce_verification_photo_write
  ON public.verification_photos;
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
         SELECT 1
           FROM public.verification_photos AS photo
          WHERE photo.verification_id = existing_record.id
            AND photo.photo_slot = 0
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
    (created_record.id, 0, 'FACE', draft.original_object_ref,
     draft.thumbnail_object_ref, draft.original_bytes, draft.thumbnail_bytes,
     draft.image_width, draft.image_height, draft.sha256,
     p_submitted_by_account_id, draft.evidence_token);

  INSERT INTO public.verification_photo_events
    (verification_id, photo_slot, event_type, actor_account_id)
  VALUES (created_record.id, 0, 'FACE_BOUND', p_submitted_by_account_id);

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

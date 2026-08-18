-- CloudBase SQL editor migration 037, part 1 / 3.
-- Create private photo tables, indexes, permissions and the write guard.
-- Run this file by itself. Continue only after COMMIT succeeds.
-- After pasting, press Ctrl+A in the editor so the entire short file is selected.
-- If the editor is already in an aborted transaction, run ROLLBACK;
-- separately before running this file. Do not prepend ROLLBACK here.
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

COMMIT;

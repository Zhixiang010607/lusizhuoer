-- CloudBase SQL editor migration 039, part 1 / 5.
-- Run this file only after 038-04 verification succeeds.
BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.verification_photos') IS NULL
     OR TO_REGPROCEDURE(
       'public.upsert_verification_extra_photo(bigint,smallint,bigint,character varying,character varying,integer,integer,integer,integer,character)'
     ) IS NULL THEN
    RAISE EXCEPTION 'migrations 037 and 038 must be executed before migration 039';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.verification_photo_upload_requests (
  request_id VARCHAR(64) PRIMARY KEY,
  verification_id BIGINT NOT NULL REFERENCES public.verification_records(id),
  photo_slot SMALLINT NOT NULL CHECK (photo_slot BETWEEN 2 AND 4),
  actor_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  status VARCHAR(16) NOT NULL
    CHECK (status IN ('UPLOADING', 'COMMITTED', 'CANCELLED', 'EXPIRED')),
  bucket_id VARCHAR(128) NOT NULL,
  original_object_ref VARCHAR(768) NOT NULL,
  thumbnail_object_ref VARCHAR(768),
  expected_original_bytes INTEGER NOT NULL
    CHECK (expected_original_bytes BETWEEN 4 AND 3145728),
  actual_original_bytes INTEGER,
  image_width INTEGER,
  image_height INTEGER,
  sha256 CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  cleanup_after TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  objects_cleaned_at TIMESTAMPTZ,
  CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$'),
  CHECK (BTRIM(bucket_id) <> ''),
  CHECK (BTRIM(original_object_ref) <> ''),
  CHECK (thumbnail_object_ref IS NULL OR BTRIM(thumbnail_object_ref) <> ''),
  CHECK (expires_at > created_at),
  CHECK (cleanup_after >= created_at + INTERVAL '3 hours'),
  CHECK (
    (status = 'UPLOADING' AND committed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'COMMITTED' AND committed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'CANCELLED' AND committed_at IS NULL AND cancelled_at IS NOT NULL)
    OR (status = 'EXPIRED' AND committed_at IS NULL)
  ),
  CHECK (
    (status <> 'COMMITTED'
      AND actual_original_bytes IS NULL
      AND image_width IS NULL AND image_height IS NULL AND sha256 IS NULL)
    OR
    (status = 'COMMITTED'
      AND actual_original_bytes BETWEEN 4 AND 3145728
      AND image_width BETWEEN 1 AND 10000
      AND image_height BETWEEN 1 AND 10000
      AND sha256 ~ '^[0-9a-f]{64}$')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_photo_upload_one_active_order
  ON public.verification_photo_upload_requests (verification_id)
  WHERE status = 'UPLOADING';
CREATE INDEX IF NOT EXISTS idx_verification_photo_upload_cleanup
  ON public.verification_photo_upload_requests
    (status, expires_at, request_id)
  WHERE status IN ('UPLOADING', 'CANCELLED', 'EXPIRED');
CREATE INDEX IF NOT EXISTS idx_verification_photo_upload_terminal_cleanup
  ON public.verification_photo_upload_requests
    (cleanup_after, request_id)
  WHERE status IN ('CANCELLED', 'EXPIRED') AND objects_cleaned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_verification_photo_upload_actor
  ON public.verification_photo_upload_requests
    (actor_account_id, verification_id, created_at DESC);

ALTER TABLE public.verification_photo_upload_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.verification_photo_upload_requests FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.verification_photo_upload_requests FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.verification_photo_upload_requests FROM anon;
  END IF;
END;
$$;

ALTER TABLE public.verification_photos
  DROP CONSTRAINT IF EXISTS verification_photos_metadata_v38_check,
  DROP CONSTRAINT IF EXISTS verification_photos_metadata_v39_check;
ALTER TABLE public.verification_photos
  ADD CONSTRAINT verification_photos_metadata_v39_check
    CHECK (
      (photo_kind = 'PROFILE'
       AND original_bytes IS NULL AND thumbnail_bytes IS NULL
       AND image_width IS NULL AND image_height IS NULL AND sha256 IS NULL)
      OR
      (photo_kind = 'FACE'
       AND original_bytes BETWEEN 1 AND 3145728
       AND thumbnail_bytes BETWEEN 1 AND 393216
       AND image_width BETWEEN 1 AND 10000
       AND image_height BETWEEN 1 AND 10000
       AND sha256 ~ '^[0-9a-f]{64}$')
      OR
      (photo_kind = 'EXTRA'
       AND original_bytes BETWEEN 1 AND 3145728
       AND image_width BETWEEN 1 AND 10000
       AND image_height BETWEEN 1 AND 10000
       AND sha256 ~ '^[0-9a-f]{64}$'
       AND (
         (thumbnail_object_ref = original_object_ref AND thumbnail_bytes IS NULL)
         OR (thumbnail_object_ref <> original_object_ref
             AND thumbnail_bytes BETWEEN 1 AND 393216)
       ))
    );

COMMIT;

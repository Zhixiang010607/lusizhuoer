-- Migration 083: raise only supplemental verification-photo evidence to 5 MiB.
-- Existing customer/teacher face images keep their independent limits.
BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.verification_photos') IS NULL
     OR TO_REGCLASS('public.verification_photo_upload_requests') IS NULL
     OR TO_REGPROCEDURE(
       'public.begin_verification_photo_upload(character varying,bigint,smallint,bigint,character varying,character varying,integer,integer)'
     ) IS NULL
     OR TO_REGPROCEDURE(
       'public.commit_verification_photo_upload(character varying,bigint,bigint,integer,integer,integer,character)'
     ) IS NULL THEN
    RAISE EXCEPTION 'migration 083 requires migrations 039 and 040';
  END IF;
END;
$$;

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT constraint_definition.conname
      FROM pg_constraint AS constraint_definition
     WHERE constraint_definition.conrelid = 'public.verification_photo_upload_requests'::regclass
       AND constraint_definition.contype = 'c'
       AND PG_GET_CONSTRAINTDEF(constraint_definition.oid) LIKE '%3145728%'
       AND (
         PG_GET_CONSTRAINTDEF(constraint_definition.oid) LIKE '%expected_original_bytes%'
         OR PG_GET_CONSTRAINTDEF(constraint_definition.oid) LIKE '%actual_original_bytes%'
       )
  LOOP
    EXECUTE FORMAT(
      'ALTER TABLE public.verification_photo_upload_requests DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END;
$$;

ALTER TABLE public.verification_photo_upload_requests
  DROP CONSTRAINT IF EXISTS verification_photo_upload_requests_bytes_v83_check,
  DROP CONSTRAINT IF EXISTS verification_photo_upload_requests_commit_metadata_v83_check;

ALTER TABLE public.verification_photo_upload_requests
  ADD CONSTRAINT verification_photo_upload_requests_bytes_v83_check
    CHECK (expected_original_bytes BETWEEN 4 AND 5242880),
  ADD CONSTRAINT verification_photo_upload_requests_commit_metadata_v83_check
    CHECK (
      (status <> 'COMMITTED'
        AND actual_original_bytes IS NULL
        AND image_width IS NULL AND image_height IS NULL AND sha256 IS NULL)
      OR
      (status = 'COMMITTED'
        AND actual_original_bytes BETWEEN 4 AND 5242880
        AND image_width BETWEEN 1 AND 10000
        AND image_height BETWEEN 1 AND 10000
        AND sha256 ~ '^[0-9a-f]{64}$')
    );

ALTER TABLE public.verification_photos
  DROP CONSTRAINT IF EXISTS verification_photos_metadata_v39_check,
  DROP CONSTRAINT IF EXISTS verification_photos_metadata_v83_check;

ALTER TABLE public.verification_photos
  ADD CONSTRAINT verification_photos_metadata_v83_check
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
       AND original_bytes BETWEEN 1 AND 5242880
       AND image_width BETWEEN 1 AND 10000
       AND image_height BETWEEN 1 AND 10000
       AND sha256 ~ '^[0-9a-f]{64}$'
       AND (
         (thumbnail_object_ref = original_object_ref AND thumbnail_bytes IS NULL)
         OR (thumbnail_object_ref <> original_object_ref
             AND thumbnail_bytes BETWEEN 1 AND 393216)
       ))
    );

DO $$
DECLARE
  begin_function TEXT;
  commit_function TEXT;
BEGIN
  SELECT PG_GET_FUNCTIONDEF(
    'public.begin_verification_photo_upload(character varying,bigint,smallint,bigint,character varying,character varying,integer,integer)'::regprocedure
  ) INTO begin_function;
  IF begin_function NOT LIKE '%3145728%' THEN
    RAISE EXCEPTION 'begin_verification_photo_upload does not expose the expected 3 MiB boundary';
  END IF;
  EXECUTE REPLACE(begin_function, '3145728', '5242880');

  SELECT PG_GET_FUNCTIONDEF(
    'public.commit_verification_photo_upload(character varying,bigint,bigint,integer,integer,integer,character)'::regprocedure
  ) INTO commit_function;
  IF commit_function NOT LIKE '%3145728%' THEN
    RAISE EXCEPTION 'commit_verification_photo_upload does not expose the expected 3 MiB boundary';
  END IF;
  EXECUTE REPLACE(commit_function, '3145728', '5242880');
END;
$$;

REVOKE ALL ON FUNCTION public.begin_verification_photo_upload(
  VARCHAR, BIGINT, SMALLINT, BIGINT, VARCHAR, VARCHAR, INTEGER, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_verification_photo_upload(
  VARCHAR, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, CHAR
) FROM PUBLIC;

COMMENT ON CONSTRAINT verification_photos_metadata_v83_check
  ON public.verification_photos IS
  'Migration 083: FACE evidence remains at 3 MiB; supplemental EXTRA evidence permits up to 5 MiB.';
COMMENT ON FUNCTION public.begin_verification_photo_upload(
  VARCHAR, BIGINT, SMALLINT, BIGINT, VARCHAR, VARCHAR, INTEGER, INTEGER
) IS 'Migration 083: begin one supplemental photo upload of at most 5 MiB.';
COMMENT ON FUNCTION public.commit_verification_photo_upload(
  VARCHAR, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, CHAR
) IS 'Migration 083: atomically commit verified supplemental photo bytes of at most 5 MiB.';

COMMIT;

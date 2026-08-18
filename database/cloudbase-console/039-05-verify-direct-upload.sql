-- CloudBase SQL editor migration 039, part 5 / 5 (read-only verification).
BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.verification_photo_upload_requests') IS NULL THEN
    RAISE EXCEPTION '039-01 did not create verification_photo_upload_requests';
  END IF;
  IF TO_REGPROCEDURE(
       'public.begin_verification_photo_upload(character varying,bigint,smallint,bigint,character varying,character varying,integer,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION '039-02 begin function is missing';
  END IF;
  IF TO_REGPROCEDURE(
       'public.commit_verification_photo_upload(character varying,bigint,bigint,integer,integer,integer,character)'
     ) IS NULL THEN
    RAISE EXCEPTION '039-03 commit function is missing';
  END IF;
  IF TO_REGPROCEDURE(
       'public.cancel_verification_photo_upload(character varying,bigint,bigint)'
     ) IS NULL THEN
    RAISE EXCEPTION '039-04 cancel function is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'uq_verification_photo_upload_one_active_order'
  ) THEN
    RAISE EXCEPTION 'single-active-upload unique index is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.verification_photos'::regclass
       AND conname = 'verification_photos_metadata_v39_check'
  ) THEN
    RAISE EXCEPTION 'v39 photo metadata constraint is missing';
  END IF;
END;
$$;

SELECT
  TO_REGCLASS('public.verification_photo_upload_requests')::TEXT AS upload_request_table,
  TO_REGPROCEDURE(
    'public.begin_verification_photo_upload(character varying,bigint,smallint,bigint,character varying,character varying,integer,integer)'
  )::TEXT AS begin_function,
  TO_REGPROCEDURE(
    'public.commit_verification_photo_upload(character varying,bigint,bigint,integer,integer,integer,character)'
  )::TEXT AS commit_function,
  TO_REGPROCEDURE(
    'public.cancel_verification_photo_upload(character varying,bigint,bigint)'
  )::TEXT AS cancel_function;

COMMIT;

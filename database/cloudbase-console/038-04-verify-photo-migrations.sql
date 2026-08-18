-- Read-only verification after all six CloudBase console parts committed.
SELECT
  TO_REGCLASS('public.verification_photo_drafts') IS NOT NULL AS drafts_table_ready,
  TO_REGCLASS('public.verification_photos') IS NOT NULL AS photos_table_ready,
  TO_REGCLASS('public.verification_photo_events') IS NOT NULL AS events_table_ready,
  TO_REGPROCEDURE(
    'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
  ) IS NOT NULL AS create_function_ready,
  TO_REGPROCEDURE(
    'public.upsert_verification_extra_photo(bigint,smallint,bigint,character varying,character varying,integer,integer,integer,integer,character)'
  ) IS NOT NULL AS extra_function_ready;

SELECT
  conname,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.verification_photos'::regclass
  AND conname IN (
    'verification_photos_slot_v38_check',
    'verification_photos_kind_v38_check',
    'verification_photos_slot_kind_v38_check',
    'verification_photos_metadata_v38_check'
  )
ORDER BY conname;

SELECT
  tgname,
  tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.verification_photos'::regclass
  AND tgname = 'trg_enforce_verification_photo_write'
  AND NOT tgisinternal;

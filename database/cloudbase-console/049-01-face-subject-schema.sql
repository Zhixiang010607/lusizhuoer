-- CloudBase migration 049, part 1 / 13. Run this file by itself.
BEGIN;
DO $$
BEGIN
  IF TO_REGCLASS('public.teacher_product_experience_quotas') IS NULL
     OR TO_REGCLASS('public.verification_photo_drafts') IS NULL
     OR TO_REGCLASS('public.verification_photos') IS NULL
     OR TO_REGPROCEDURE('public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)') IS NULL THEN
    RAISE EXCEPTION 'migration 049 requires migrations through 048';
  END IF;
END;
$$;

ALTER TABLE public.teachers
  ADD COLUMN IF NOT EXISTS profile_photo_file_id VARCHAR(768);

ALTER TABLE public.verification_photo_drafts
  ADD COLUMN IF NOT EXISTS face_subject_type VARCHAR(16) NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS face_subject_teacher_id BIGINT;
ALTER TABLE public.verification_records
  ADD COLUMN IF NOT EXISTS face_subject_type VARCHAR(16) NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS face_subject_teacher_id BIGINT;
ALTER TABLE public.verification_photos
  ADD COLUMN IF NOT EXISTS face_subject_type VARCHAR(16) NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS face_subject_teacher_id BIGINT;

COMMIT;

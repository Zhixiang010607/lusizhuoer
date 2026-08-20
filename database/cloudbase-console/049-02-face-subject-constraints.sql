-- CloudBase migration 049, part 2 / 13. Run this file by itself.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'verification_photo_drafts_face_subject_teacher_fk'
                    AND conrelid = 'public.verification_photo_drafts'::regclass) THEN
    ALTER TABLE public.verification_photo_drafts ADD CONSTRAINT verification_photo_drafts_face_subject_teacher_fk
      FOREIGN KEY (face_subject_teacher_id) REFERENCES public.teachers(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'verification_records_face_subject_teacher_fk'
                    AND conrelid = 'public.verification_records'::regclass) THEN
    ALTER TABLE public.verification_records ADD CONSTRAINT verification_records_face_subject_teacher_fk
      FOREIGN KEY (face_subject_teacher_id) REFERENCES public.teachers(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'verification_photos_face_subject_teacher_fk'
                    AND conrelid = 'public.verification_photos'::regclass) THEN
    ALTER TABLE public.verification_photos ADD CONSTRAINT verification_photos_face_subject_teacher_fk
      FOREIGN KEY (face_subject_teacher_id) REFERENCES public.teachers(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.verification_photo_drafts
  DROP CONSTRAINT IF EXISTS verification_photo_drafts_face_subject_check;
ALTER TABLE public.verification_photo_drafts
  ADD CONSTRAINT verification_photo_drafts_face_subject_check CHECK (
    (face_subject_type = 'CUSTOMER' AND face_subject_teacher_id IS NULL)
    OR (face_subject_type = 'TEACHER' AND face_subject_teacher_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_face_subject_check;
ALTER TABLE public.verification_records
  ADD CONSTRAINT verification_records_face_subject_check CHECK (
    (face_subject_type = 'CUSTOMER' AND face_subject_teacher_id IS NULL)
    OR (face_subject_type = 'TEACHER' AND face_subject_teacher_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE public.verification_photos
  DROP CONSTRAINT IF EXISTS verification_photos_face_subject_check;
ALTER TABLE public.verification_photos
  ADD CONSTRAINT verification_photos_face_subject_check CHECK (
    (face_subject_type = 'CUSTOMER' AND face_subject_teacher_id IS NULL)
    OR (face_subject_type = 'TEACHER' AND face_subject_teacher_id IS NOT NULL)
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_verification_photo_drafts_teacher_subject
  ON public.verification_photo_drafts (face_subject_teacher_id, created_at DESC)
  WHERE face_subject_type = 'TEACHER' AND consumed_at IS NULL;

COMMIT;

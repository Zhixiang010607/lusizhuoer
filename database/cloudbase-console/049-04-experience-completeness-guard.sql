-- CloudBase migration 049, part 4 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.assert_experience_verification_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verification_type = 'EXPERIENCE' AND (
    NOT EXISTS (
      SELECT 1 FROM public.teacher_experience_quota_usages AS usage
       WHERE usage.verification_id = NEW.id AND usage.teacher_id = NEW.teacher_id
         AND usage.product_id = NEW.product_id AND usage.unit_count = NEW.unit_count
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.verification_photos AS photo
       WHERE photo.verification_id = NEW.id AND photo.photo_slot = 0
         AND photo.photo_kind = 'PROFILE' AND photo.face_subject_type = 'TEACHER'
         AND photo.face_subject_teacher_id = NEW.teacher_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.verification_photos AS photo
       WHERE photo.verification_id = NEW.id AND photo.photo_slot = 1
         AND photo.photo_kind = 'FACE' AND photo.face_subject_type = 'TEACHER'
         AND photo.face_subject_teacher_id = NEW.teacher_id
    )
  ) THEN
    RAISE EXCEPTION 'EXPERIENCE verification requires teacher quota usage and two teacher face photos'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_experience_verification_complete ON public.verification_records;
CREATE CONSTRAINT TRIGGER trg_assert_experience_verification_complete
AFTER INSERT ON public.verification_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_experience_verification_complete();

COMMIT;

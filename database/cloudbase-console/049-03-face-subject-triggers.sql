-- CloudBase migration 049, part 3 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.enforce_verification_face_subject()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verification_type = 'EXPERIENCE' THEN
    IF NEW.face_subject_type <> 'TEACHER'
       OR NEW.face_subject_teacher_id IS DISTINCT FROM NEW.teacher_id THEN
      RAISE EXCEPTION 'EXPERIENCE verification requires its teacher as the face subject'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.face_subject_type <> 'CUSTOMER' OR NEW.face_subject_teacher_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-EXPERIENCE verification requires its customer as the face subject'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_verification_face_subject ON public.verification_records;
CREATE TRIGGER trg_enforce_verification_face_subject
BEFORE INSERT OR UPDATE OF verification_type, teacher_id, face_subject_type, face_subject_teacher_id
ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_verification_face_subject();

CREATE OR REPLACE FUNCTION public.inherit_verification_photo_face_subject()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT record.face_subject_type, record.face_subject_teacher_id
    INTO NEW.face_subject_type, NEW.face_subject_teacher_id
    FROM public.verification_records AS record
   WHERE record.id = NEW.verification_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification record does not exist' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inherit_verification_photo_face_subject ON public.verification_photos;
CREATE TRIGGER trg_inherit_verification_photo_face_subject
BEFORE INSERT OR UPDATE OF verification_id ON public.verification_photos
FOR EACH ROW EXECUTE FUNCTION public.inherit_verification_photo_face_subject();

COMMIT;

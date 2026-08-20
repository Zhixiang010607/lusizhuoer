-- CloudBase migration 049, part 13 / 13. Run this file by itself.
BEGIN;
REVOKE ALL ON FUNCTION public.enforce_verification_face_subject() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inherit_verification_photo_face_subject() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_experience_verification_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_teacher_product_experience_quota(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_active_teacher_experience_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_teacher_experience_quota(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_teacher_experience_face_photos(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_teacher_experience_verification_replay(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.insert_teacher_experience_verification(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_experience_verification_with_teacher_face_photo(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC;

COMMENT ON COLUMN public.teachers.profile_photo_file_id IS
  'Private immutable retained-photo reference for the teacher current face enrollment; old referenced objects remain for historical verification snapshots.';
COMMENT ON COLUMN public.verification_records.face_subject_type IS
  'CUSTOMER for historical/normal verification evidence; TEACHER for every new EXPERIENCE verification after migration 049.';
COMMENT ON FUNCTION public.create_experience_verification_with_teacher_face_photo(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR) IS
  'Atomically creates a customer-linked EXPERIENCE verification, snapshots the teacher retained photo, binds the teacher live photo, and consumes one teacher quota unit.';

COMMIT;

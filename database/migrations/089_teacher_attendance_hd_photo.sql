-- Preserve native attendance photo pixels and the work-order 3 MiB ceiling.
-- No attendance rows, object references, times or immutable guards are changed.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = TO_REGCLASS('public.teacher_attendance_records')
      AND tgname = 'trg_teacher_attendance_insert_v78' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = TO_REGCLASS('public.teacher_attendance_records')
      AND tgname = 'trg_z_teacher_attendance_photo_v88' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '089 requires immutable attendance migrations 078 and 088';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.teacher_attendance_records'::regclass
      AND conname = 'teacher_attendance_photo_check_v89') THEN
    ALTER TABLE public.teacher_attendance_records
      ADD CONSTRAINT teacher_attendance_photo_check_v89 CHECK (
        (photo_object_ref IS NULL AND photo_bytes IS NULL AND photo_sha256 IS NULL
         AND photo_width IS NULL AND photo_height IS NULL AND photo_taken_at IS NULL)
        OR
        (photo_object_ref IS NOT NULL AND photo_bytes IS NOT NULL AND photo_sha256 IS NOT NULL
         AND photo_width IS NOT NULL AND photo_height IS NOT NULL AND photo_taken_at IS NOT NULL
         AND photo_object_ref ~ '^pg://[^/]+/attendance/[a-f0-9]{48}[.]jpg$'
         AND photo_bytes BETWEEN 4 AND 3145728 AND photo_sha256 ~ '^[a-f0-9]{64}$'
         AND photo_width BETWEEN 160 AND 10000 AND photo_height BETWEEN 160 AND 10000
         AND photo_width::bigint * photo_height::bigint <= 25165824
         AND photo_taken_at = checked_in_at));
  END IF;
END;
$$;
ALTER TABLE public.teacher_attendance_records
  VALIDATE CONSTRAINT teacher_attendance_photo_check_v89;
ALTER TABLE public.teacher_attendance_records
  DROP CONSTRAINT IF EXISTS teacher_attendance_photo_check_v88;
COMMIT;

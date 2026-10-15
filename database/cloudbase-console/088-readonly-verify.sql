-- Run independently after 088-01. Aggregate metadata only, no face references.
SELECT 'photo columns' AS check_name,
       CASE WHEN COUNT(*) = 6 THEN 'READY' ELSE 'MISSING' END AS status
  FROM information_schema.columns WHERE table_schema = 'public'
   AND table_name = 'teacher_attendance_records'
   AND column_name IN ('photo_object_ref','photo_bytes','photo_sha256','photo_width','photo_height','photo_taken_at')
UNION ALL
SELECT 'photo guard', CASE WHEN EXISTS (SELECT 1 FROM pg_trigger
 WHERE tgrelid = 'public.teacher_attendance_records'::regclass
   AND tgname = 'trg_z_teacher_attendance_photo_v88' AND NOT tgisinternal) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'immutable two-punch guard', CASE WHEN EXISTS (SELECT 1 FROM pg_trigger
 WHERE tgrelid = 'public.teacher_attendance_records'::regclass
   AND tgname = 'trg_teacher_attendance_insert_v78' AND NOT tgisinternal) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'photo integrity constraint', CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
 WHERE conrelid = 'public.teacher_attendance_records'::regclass
   AND conname = 'teacher_attendance_photo_check_v88' AND convalidated) THEN 'READY' ELSE 'MISSING' END;

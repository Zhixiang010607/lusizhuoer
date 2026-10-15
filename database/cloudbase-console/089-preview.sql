-- Read-only. Preserve this result privately before the full backup gate.
SELECT CURRENT_DATABASE() AS database_name,
       COUNT(*) AS attendance_rows,
       COUNT(photo_object_ref) AS bound_photos,
       MAX(photo_bytes) AS largest_photo_bytes
  FROM public.teacher_attendance_records;
SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.teacher_attendance_records'::regclass
   AND conname IN ('teacher_attendance_photo_check_v88','teacher_attendance_photo_check_v89');
SELECT tgname, tgenabled, md5(pg_get_triggerdef(oid)) AS definition_hash,
       md5(pg_get_functiondef(tgfoid)) AS function_hash
  FROM pg_trigger
 WHERE tgrelid = 'public.teacher_attendance_records'::regclass
   AND tgname IN ('trg_teacher_attendance_insert_v78','trg_z_teacher_attendance_photo_v88')
 ORDER BY tgname;
SELECT id, public, file_size_limit, allowed_mime_types
  FROM storage.buckets
 WHERE id IN ('customer-photos','verification-photos') ORDER BY id;

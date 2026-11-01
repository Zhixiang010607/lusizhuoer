-- Read-only; all checks must be READY. Compare preview with the private baseline.
SELECT 'photo_method_constraint' AS check_name,
  CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.teacher_attendance_records'::regclass
      AND conname = 'teacher_attendance_method_check_v90' AND convalidated)
    THEN 'READY' ELSE 'NOT_READY' END AS status
UNION ALL
SELECT 'nullable_face_audit', CASE WHEN (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'teacher_attendance_records'
    AND column_name IN ('face_score','face_request_id') AND is_nullable = 'YES') = 2
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL
SELECT 'private_photo_guard', CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.teacher_attendance_records'::regclass
    AND conname = 'teacher_attendance_photo_check_v89' AND convalidated)
  AND EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.teacher_attendance_records'::regclass
      AND tgname = 'trg_z_teacher_attendance_photo_v88' AND tgenabled = 'O')
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL
SELECT 'immutable_active_teacher_guard', CASE WHEN EXISTS (SELECT 1 FROM pg_trigger
  WHERE tgrelid = 'public.teacher_attendance_records'::regclass
    AND tgname = 'trg_teacher_attendance_insert_v78' AND tgenabled = 'O'
    AND pg_get_functiondef(tgfoid) LIKE '%NEW.attendance_method = ''FACE''%'
    AND pg_get_functiondef(tgfoid) LIKE '%TG_OP <> ''INSERT''%')
  THEN 'READY' ELSE 'NOT_READY' END;

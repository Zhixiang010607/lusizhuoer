SELECT 'attendance_face_profiles_table' AS item,
       CASE WHEN TO_REGCLASS('public.teacher_attendance_face_profiles') IS NOT NULL THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'attendance_records_table',
       CASE WHEN TO_REGCLASS('public.teacher_attendance_records') IS NOT NULL THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'attendance_date_index',
       CASE WHEN TO_REGCLASS('public.idx_teacher_attendance_records_date_teacher') IS NOT NULL THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'attendance_immutable_trigger',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = TO_REGCLASS('public.teacher_attendance_records')
            AND tgname = 'trg_teacher_attendance_insert_v75' AND NOT tgisinternal
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'no_clockin_photo_column',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'teacher_attendance_records'
            AND column_name ILIKE '%photo%'
       ) THEN 'READY' ELSE 'UNEXPECTED' END
ORDER BY item;

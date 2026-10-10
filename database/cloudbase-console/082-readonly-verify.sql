SELECT '082 profile columns' AS check_name,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'teacher_attendance_face_profiles'
            AND column_name = 'replacement_count'
       ) AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'teacher_attendance_face_profiles'
            AND column_name = 'updated_at'
       ) THEN 'READY' ELSE 'MISSING' END AS status

UNION ALL

SELECT '082 replacement audit' AS check_name,
       CASE WHEN TO_REGCLASS('public.teacher_attendance_face_replacements') IS NOT NULL
            THEN 'READY' ELSE 'MISSING' END AS status

UNION ALL

SELECT '082 replacement guard' AS check_name,
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = TO_REGCLASS('public.teacher_attendance_face_profiles')
            AND tgname = 'trg_teacher_attendance_face_profile_update_v82'
            AND NOT tgisinternal
       ) THEN 'READY' ELSE 'MISSING' END AS status

UNION ALL

SELECT '082 service role update' AS check_name,
       CASE WHEN HAS_TABLE_PRIVILEGE('service_role', 'public.teacher_attendance_face_profiles', 'UPDATE')
            AND HAS_TABLE_PRIVILEGE('service_role', 'public.teacher_attendance_face_replacements', 'INSERT')
            THEN 'READY' ELSE 'MISSING' END AS status;

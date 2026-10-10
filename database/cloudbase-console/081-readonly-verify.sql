-- Migration 081 read-only verification. Expected: all four rows are READY.

SELECT 'attendance_readable_address_columns' AS check_name,
       CASE WHEN COUNT(*) = 3 THEN 'READY' ELSE 'BLOCKED' END AS status
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'teacher_attendance_records'
   AND column_name IN ('place_name', 'formatted_address', 'address_provider')
UNION ALL
SELECT 'attendance_readable_address_constraints' AS check_name,
       CASE WHEN COUNT(*) = 3 THEN 'READY' ELSE 'BLOCKED' END AS status
  FROM pg_constraint
 WHERE conrelid = 'public.teacher_attendance_records'::regclass
   AND conname IN (
     'teacher_attendance_place_name_check',
     'teacher_attendance_formatted_address_check',
     'teacher_attendance_address_provider_check'
   )
UNION ALL
SELECT 'attendance_readable_address_service_role' AS check_name,
       CASE WHEN has_table_privilege('service_role', 'public.teacher_attendance_records', 'SELECT')
                  AND has_table_privilege('service_role', 'public.teacher_attendance_records', 'INSERT')
            THEN 'READY' ELSE 'BLOCKED' END AS status
UNION ALL
SELECT 'attendance_readable_address_client_blocked' AS check_name,
       CASE WHEN NOT has_table_privilege('anon', 'public.teacher_attendance_records', 'SELECT')
                  AND NOT has_table_privilege('anon', 'public.teacher_attendance_records', 'INSERT')
                  AND NOT has_table_privilege('anon', 'public.teacher_attendance_records', 'UPDATE')
                  AND NOT has_table_privilege('anon', 'public.teacher_attendance_records', 'DELETE')
                  AND NOT has_table_privilege('authenticated', 'public.teacher_attendance_records', 'SELECT')
                  AND NOT has_table_privilege('authenticated', 'public.teacher_attendance_records', 'INSERT')
                  AND NOT has_table_privilege('authenticated', 'public.teacher_attendance_records', 'UPDATE')
                  AND NOT has_table_privilege('authenticated', 'public.teacher_attendance_records', 'DELETE')
            THEN 'READY' ELSE 'BLOCKED' END AS status;

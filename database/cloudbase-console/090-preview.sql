-- Read-only. Save privately before migration and repeat afterwards.
SELECT current_database() AS database_name,
       COUNT(*) AS records, COUNT(photo_object_ref) AS photos,
       MD5(COALESCE(STRING_AGG((TO_JSONB(r) - 'attendance_method')::text, '' ORDER BY id), '')) AS historical_digest
FROM public.teacher_attendance_records r;
SELECT tgname, tgenabled, MD5(pg_get_functiondef(tgfoid)) AS guard_digest
FROM pg_trigger WHERE tgrelid = 'public.teacher_attendance_records'::regclass AND NOT tgisinternal
ORDER BY tgname;

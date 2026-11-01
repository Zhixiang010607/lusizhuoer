-- Read-only. Save privately before migration and repeat afterwards.
SELECT current_database() AS database_name,
       COUNT(*) AS records, COUNT(photo_object_ref) AS photos,
       MD5(COALESCE(STRING_AGG((TO_JSONB(r) - 'attendance_method')::text, '' ORDER BY id), '')) AS historical_digest,
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
          'name', tgname, 'enabled', tgenabled,
          'digest', MD5(pg_get_functiondef(tgfoid))) ORDER BY tgname)
        FROM pg_trigger WHERE tgrelid = 'public.teacher_attendance_records'::regclass
          AND NOT tgisinternal) AS guards
FROM public.teacher_attendance_records r;

-- Read-only production preflight. Metadata and aggregate counts only.
SELECT CURRENT_DATABASE() AS database_name,
       TO_REGCLASS('public.teacher_attendance_records') AS attendance_table,
       TO_REGCLASS('public.teacher_attendance_face_profiles') AS attendance_face_table,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = TO_REGCLASS('public.teacher_attendance_records')
         AND tgname = 'trg_teacher_attendance_insert_v78' AND NOT tgisinternal) AS two_punch_guard,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
         AND table_name = 'teacher_attendance_records' AND column_name = 'formatted_address') AS address_schema,
       (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public'
         AND table_name = 'teacher_attendance_records'
         AND column_name IN ('photo_object_ref','photo_bytes','photo_sha256','photo_width','photo_height','photo_taken_at')) AS photo_columns,
       (SELECT COUNT(*) FROM public.teacher_attendance_records) AS attendance_records,
       (SELECT JSON_AGG(JSON_BUILD_OBJECT('id',id,'public',public,'file_size_limit',file_size_limit,
          'allowed_mime_types',allowed_mime_types)) FROM storage.buckets
          WHERE id IN ('customer-photos','verification-photos')) AS photo_buckets,
       (SELECT JSON_AGG(JSON_BUILD_OBJECT('name',tgname,'enabled',tgenabled)) FROM pg_trigger
          WHERE tgrelid = 'public.teacher_attendance_records'::regclass AND NOT tgisinternal) AS attendance_triggers;

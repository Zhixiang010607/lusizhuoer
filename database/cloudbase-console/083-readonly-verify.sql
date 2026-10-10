SELECT '083 request constraints' AS check_name,
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.verification_photo_upload_requests'::regclass
            AND conname = 'verification_photo_upload_requests_bytes_v83_check'
            AND PG_GET_CONSTRAINTDEF(oid) LIKE '%5242880%'
       ) AND EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.verification_photo_upload_requests'::regclass
            AND conname = 'verification_photo_upload_requests_commit_metadata_v83_check'
            AND PG_GET_CONSTRAINTDEF(oid) LIKE '%5242880%'
       ) THEN 'READY' ELSE 'MISSING' END AS status

UNION ALL

SELECT '083 photo constraint' AS check_name,
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.verification_photos'::regclass
            AND conname = 'verification_photos_metadata_v83_check'
            AND PG_GET_CONSTRAINTDEF(oid) LIKE '%photo_kind%FACE%3145728%'
            AND PG_GET_CONSTRAINTDEF(oid) LIKE '%photo_kind%EXTRA%5242880%'
       ) THEN 'READY' ELSE 'MISSING' END AS status

UNION ALL

SELECT '083 begin function' AS check_name,
       CASE WHEN PG_GET_FUNCTIONDEF(
         'public.begin_verification_photo_upload(character varying,bigint,smallint,bigint,character varying,character varying,integer,integer)'::regprocedure
       ) LIKE '%5242880%'
       THEN 'READY' ELSE 'MISSING' END AS status

UNION ALL

SELECT '083 commit function' AS check_name,
       CASE WHEN PG_GET_FUNCTIONDEF(
         'public.commit_verification_photo_upload(character varying,bigint,bigint,integer,integer,integer,character)'::regprocedure
       ) LIKE '%5242880%'
       THEN 'READY' ELSE 'MISSING' END AS status

UNION ALL

SELECT '083 existing data' AS check_name,
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM public.verification_photo_upload_requests
          WHERE expected_original_bytes > 5242880
             OR actual_original_bytes > 5242880
       ) AND NOT EXISTS (
         SELECT 1 FROM public.verification_photos
          WHERE photo_kind = 'EXTRA' AND original_bytes > 5242880
       ) THEN 'READY' ELSE 'MISSING' END AS status

UNION ALL

SELECT '083 private photo bucket' AS check_name,
       CASE WHEN EXISTS (
         SELECT 1
           FROM storage.buckets
          WHERE id = 'customer-photos'
            AND public = FALSE
            AND file_size_limit >= 5242880
            AND 'image/jpeg' = ANY(allowed_mime_types)
       ) THEN 'READY' ELSE 'MISSING' END AS status;

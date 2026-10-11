SELECT 'training_materials_table' AS item,
       CASE WHEN TO_REGCLASS('public.training_materials') IS NOT NULL THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'training_materials_status_index',
       CASE WHEN TO_REGCLASS('public.idx_training_materials_status_time') IS NOT NULL THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'training_materials_rls_enabled',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_class
          WHERE oid = TO_REGCLASS('public.training_materials') AND relrowsecurity
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'training_materials_client_access_closed',
       CASE WHEN NOT HAS_TABLE_PRIVILEGE('anon', 'public.training_materials', 'SELECT')
                  AND NOT HAS_TABLE_PRIVILEGE('authenticated', 'public.training_materials', 'SELECT')
                  AND NOT HAS_TABLE_PRIVILEGE('service_role', 'public.training_materials', 'DELETE')
            THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'training_materials_private_pdf_bucket',
       CASE WHEN EXISTS (
         SELECT 1
           FROM storage.buckets
          WHERE id = 'training-materials'
            AND public = FALSE
            AND file_size_limit = 104857600
            AND 'application/pdf' = ANY(allowed_mime_types)
       ) THEN 'READY' ELSE 'MISSING' END;

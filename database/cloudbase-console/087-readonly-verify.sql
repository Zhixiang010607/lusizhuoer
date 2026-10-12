SELECT 'training deletion finalizer' AS check_name,
       CASE WHEN to_regprocedure('public.finalize_training_material_deletion(bigint,text)') IS NOT NULL
         AND has_function_privilege('service_role', 'public.finalize_training_material_deletion(bigint,text)', 'EXECUTE')
         THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'request tombstones', CASE WHEN to_regclass('public.training_material_deleted_requests') IS NOT NULL THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'no client access', CASE WHEN NOT has_schema_privilege('anon', 'public', 'USAGE')
  AND NOT has_schema_privilege('authenticated', 'public', 'USAGE') THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'upload resurrection guard', CASE WHEN EXISTS (
 SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.training_materials'::regclass
 AND tgname = 'guard_deleted_training_upload' AND NOT tgisinternal AND tgenabled = 'O'
) THEN 'READY' ELSE 'MISSING' END;

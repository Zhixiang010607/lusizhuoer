-- Read-only deployment check for faceRecognition v52.
-- This is not a migration and changes no database data or permissions.

SELECT
  CURRENT_DATABASE() AS database_name,
  TO_REGCLASS('public.verification_photo_upload_requests') AS upload_request_table,
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types,
  (
    public = FALSE
    AND (file_size_limit IS NULL OR file_size_limit >= 3145728)
    AND (allowed_mime_types IS NULL OR 'image/jpeg' = ANY(allowed_mime_types))
  ) AS verification_photo_ready
FROM storage.buckets
WHERE id IN ('customer-photos', 'verification-photos')
ORDER BY id;

-- An empty result here is intentional for this private, server-only bucket.
-- CloudBase service_role bypasses RLS; do not grant anon/authenticated broad
-- object access merely to remove the console warning.
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename IN ('buckets', 'objects')
ORDER BY tablename, policyname;

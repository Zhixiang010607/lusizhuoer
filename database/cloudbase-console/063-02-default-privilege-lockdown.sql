-- 063 emergency step 2: keep future public-schema objects private by default.
-- This is separate from step 1 so a provider ownership error cannot reopen
-- the existing objects already closed by step 1.

BEGIN;

DO $$
DECLARE
  owner_row RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'CloudBase roles anon, authenticated and service_role are required';
  END IF;

  FOR owner_row IN
    WITH public_object_owners AS (
      SELECT CURRENT_USER::TEXT AS role_name
      UNION
      SELECT PG_GET_USERBYID(class.relowner)
        FROM pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
       WHERE namespace.nspname = 'public'
      UNION
      SELECT PG_GET_USERBYID(proc.proowner)
        FROM pg_proc AS proc
        JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
       WHERE namespace.nspname = 'public'
      UNION
      SELECT PG_GET_USERBYID(default_acl.defaclrole)
        FROM pg_default_acl AS default_acl
       WHERE default_acl.defaclnamespace IN (0, 'public'::regnamespace::oid)
    )
    SELECT role_name
      FROM public_object_owners
     WHERE role_name IS NOT NULL
     ORDER BY role_name
  LOOP
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated', owner_row.role_name);

    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL ON TABLES TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL ON SEQUENCES TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON TABLES TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role', owner_row.role_name);
    EXECUTE FORMAT('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role', owner_row.role_name);
  END LOOP;
END;
$$;

COMMIT;

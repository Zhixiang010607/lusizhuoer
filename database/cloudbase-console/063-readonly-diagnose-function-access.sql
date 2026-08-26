-- 063 read-only diagnostic: identify every routine still executable by a
-- client role and the direct or inherited ACL source.  This changes nothing.

WITH RECURSIVE client_roles AS (
  SELECT oid, rolname
    FROM pg_roles
   WHERE rolname IN ('anon', 'authenticated')
), inherited_roles AS (
  SELECT client.oid AS client_oid, client.rolname AS client_role,
         client.oid AS grant_role_oid
    FROM client_roles AS client
  UNION
  SELECT inherited.client_oid, inherited.client_role, membership.roleid
    FROM inherited_roles AS inherited
    JOIN pg_auth_members AS membership
      ON membership.member = inherited.grant_role_oid
), routines AS (
  SELECT proc.oid, proc.proowner, proc.prokind, proc.proacl
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
   WHERE namespace.nspname = 'public'
), exposed AS (
  SELECT client.rolname AS client_role,
         routine.oid::regprocedure::TEXT AS routine_signature,
         CASE routine.prokind
           WHEN 'p' THEN 'PROCEDURE'
           WHEN 'a' THEN 'AGGREGATE'
           WHEN 'w' THEN 'WINDOW'
           ELSE 'FUNCTION'
         END AS routine_type,
         PG_GET_USERBYID(routine.proowner) AS owner_role,
         COALESCE(source.grant_sources, 'owner or provider-internal') AS grant_sources,
         COALESCE(routine.proacl::TEXT, '<implicit default ACL>') AS explicit_acl
    FROM client_roles AS client
    CROSS JOIN routines AS routine
    LEFT JOIN LATERAL (
      SELECT STRING_AGG(DISTINCT CASE
               WHEN privilege.grantee = 0 THEN 'PUBLIC'
               ELSE PG_GET_USERBYID(privilege.grantee)
             END, ', ') AS grant_sources
        FROM ACLEXPLODE(COALESCE(
               routine.proacl, ACLDEFAULT('f', routine.proowner)
             )) AS privilege
       WHERE privilege.privilege_type = 'EXECUTE'
         AND (privilege.grantee = 0 OR privilege.grantee IN (
           SELECT inherited.grant_role_oid
             FROM inherited_roles AS inherited
            WHERE inherited.client_oid = client.oid
         ))
    ) AS source ON TRUE
   WHERE HAS_FUNCTION_PRIVILEGE(client.oid, routine.oid, 'EXECUTE')
)
SELECT client_role, routine_signature, routine_type, owner_role,
       grant_sources, explicit_acl
  FROM exposed
 ORDER BY routine_signature, client_role;

-- 063 read-only verification 1/2: current client and service-role access.

WITH relations AS (
  SELECT class.oid, class.relkind
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
   WHERE namespace.nspname = 'public'
     AND class.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), functions AS (
  SELECT proc.oid,
         PG_GET_USERBYID(proc.proowner) = 'tencentdb_cloudbase_root'
           AND proc.pronargs = 0
           AND proc.proname IN (
             'guard_system_tables', 'guard_system_tables_on_drop'
           ) AS provider_guard
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
   WHERE namespace.nspname = 'public'
), checks AS (
  SELECT 1 AS sort_order, 'client schema access closed'::TEXT AS check_name,
         CASE WHEN NOT HAS_SCHEMA_PRIVILEGE('anon', 'public', 'USAGE')
                    AND NOT HAS_SCHEMA_PRIVILEGE('anon', 'public', 'CREATE')
                    AND NOT HAS_SCHEMA_PRIVILEGE('authenticated', 'public', 'USAGE')
                    AND NOT HAS_SCHEMA_PRIVILEGE('authenticated', 'public', 'CREATE')
              THEN 0 ELSE 1 END::BIGINT AS record_count
  UNION ALL
  SELECT 2, 'client table access closed', COUNT(*)::BIGINT FROM relations AS relation
   WHERE relation.relkind <> 'S' AND (
     HAS_TABLE_PRIVILEGE('anon', relation.oid, 'SELECT') OR HAS_TABLE_PRIVILEGE('anon', relation.oid, 'INSERT')
     OR HAS_TABLE_PRIVILEGE('anon', relation.oid, 'UPDATE') OR HAS_TABLE_PRIVILEGE('anon', relation.oid, 'DELETE')
     OR HAS_TABLE_PRIVILEGE('anon', relation.oid, 'TRUNCATE') OR HAS_TABLE_PRIVILEGE('anon', relation.oid, 'REFERENCES')
     OR HAS_TABLE_PRIVILEGE('anon', relation.oid, 'TRIGGER') OR HAS_TABLE_PRIVILEGE('authenticated', relation.oid, 'SELECT')
     OR HAS_TABLE_PRIVILEGE('authenticated', relation.oid, 'INSERT') OR HAS_TABLE_PRIVILEGE('authenticated', relation.oid, 'UPDATE')
     OR HAS_TABLE_PRIVILEGE('authenticated', relation.oid, 'DELETE') OR HAS_TABLE_PRIVILEGE('authenticated', relation.oid, 'TRUNCATE')
     OR HAS_TABLE_PRIVILEGE('authenticated', relation.oid, 'REFERENCES') OR HAS_TABLE_PRIVILEGE('authenticated', relation.oid, 'TRIGGER'))
  UNION ALL
  SELECT 3, 'client sequence access closed', COUNT(*)::BIGINT FROM relations AS relation
   WHERE relation.relkind = 'S' AND (
     HAS_SEQUENCE_PRIVILEGE('anon', relation.oid, 'USAGE') OR HAS_SEQUENCE_PRIVILEGE('anon', relation.oid, 'SELECT')
     OR HAS_SEQUENCE_PRIVILEGE('anon', relation.oid, 'UPDATE') OR HAS_SEQUENCE_PRIVILEGE('authenticated', relation.oid, 'USAGE')
     OR HAS_SEQUENCE_PRIVILEGE('authenticated', relation.oid, 'SELECT') OR HAS_SEQUENCE_PRIVILEGE('authenticated', relation.oid, 'UPDATE'))
  UNION ALL
  SELECT 4, 'client function execution closed', COUNT(*)::BIGINT FROM functions AS function
   WHERE (HAS_FUNCTION_PRIVILEGE('anon', function.oid, 'EXECUTE')
          AND (NOT function.provider_guard
               OR HAS_SCHEMA_PRIVILEGE('anon', 'public', 'USAGE')))
      OR (HAS_FUNCTION_PRIVILEGE('authenticated', function.oid, 'EXECUTE')
          AND (NOT function.provider_guard
               OR HAS_SCHEMA_PRIVILEGE('authenticated', 'public', 'USAGE')))
)
SELECT check_name, record_count,
       CASE WHEN record_count = 0 THEN 'READY' ELSE 'UNSAFE' END AS status
  FROM checks ORDER BY sort_order;

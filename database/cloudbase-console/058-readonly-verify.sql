WITH expected(table_name,trigger_name,function_name,marker) AS (
  VALUES ('recharge_records','trg_058_recharge_integrity','enforce_current_recharge_integrity','CURRENT_RECHARGE_INTEGRITY_V58'),
         ('verification_records','trg_058_verification_integrity','enforce_current_verification_integrity','CURRENT_VERIFICATION_INTEGRITY_V58')
), actual AS (
  SELECT c.relname AS table_name,t.tgname AS trigger_name,p.proname AS function_name,
         PG_GET_FUNCTIONDEF(p.oid) AS function_def
  FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE n.nspname='public' AND NOT t.tgisinternal
)
SELECT e.table_name,e.trigger_name,
       CASE WHEN a.function_name=e.function_name
                  AND POSITION(e.marker IN a.function_def)>0
            THEN 'READY' ELSE 'MISSING' END AS status
FROM expected e LEFT JOIN actual a USING(table_name,trigger_name)
ORDER BY 1,2;

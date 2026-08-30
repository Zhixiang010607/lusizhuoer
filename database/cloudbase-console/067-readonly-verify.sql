SELECT
  'refund query indexes' AS check_name,
  COUNT(*) AS record_count,
  CASE WHEN COUNT(*) = 4 THEN 'READY' ELSE 'CHECK' END AS status
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'recharge_records'
  AND indexname IN (
    'idx_recharge_store_type_cursor',
    'idx_recharge_store_type_status_cursor',
    'idx_recharge_type_cursor',
    'idx_recharge_type_product_store_cursor'
  )

UNION ALL

SELECT
  'invalid refund query indexes' AS check_name,
  COUNT(*) AS record_count,
  CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'CHECK' END AS status
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'idx_recharge_store_type_cursor',
    'idx_recharge_store_type_status_cursor',
    'idx_recharge_type_cursor',
    'idx_recharge_type_product_store_cursor'
  )
  AND NOT i.indisvalid

UNION ALL

SELECT
  'refund rows present' AS check_name,
  COUNT(*) AS record_count,
  CASE WHEN COUNT(*) > 0 THEN 'READY' ELSE 'EMPTY' END AS status
FROM public.recharge_records
WHERE recharge_type = 'REFUND';

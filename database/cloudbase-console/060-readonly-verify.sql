WITH expected_columns(column_name) AS (
  VALUES ('id'), ('product_code'), ('product_name'), ('product_status'), ('idempotency_key'),
         ('created_by_staff_account_id'), ('updated_by_staff_account_id'), ('created_at'), ('updated_at')
), column_check AS (
  SELECT COUNT(*)::INTEGER AS record_count
  FROM expected_columns e
  JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = 'retail_products'
   AND c.column_name = e.column_name
), trigger_check AS (
  SELECT COUNT(*)::INTEGER AS record_count
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'retail_products'
    AND NOT t.tgisinternal
    AND t.tgname IN ('trg_060_audit_retail_product_status', 'trg_060_prevent_retail_product_delete')
), index_check AS (
  SELECT COUNT(*)::INTEGER AS record_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'retail_products'
    AND indexname IN ('uq_retail_products_normalized_name', 'uq_retail_products_idempotency_key', 'idx_retail_products_status_id')
), history_check AS (
  SELECT COUNT(*)::INTEGER AS record_count
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'retail_product_status_history'
)
SELECT 'retail product columns' AS check_name, record_count,
       CASE WHEN record_count = 9 THEN 'READY' ELSE 'MISSING' END AS status
FROM column_check
UNION ALL
SELECT 'archive audit and delete guard triggers', record_count,
       CASE WHEN record_count = 2 THEN 'READY' ELSE 'MISSING' END
FROM trigger_check
UNION ALL
SELECT 'retail product indexes', record_count,
       CASE WHEN record_count = 3 THEN 'READY' ELSE 'MISSING' END
FROM index_check
UNION ALL
SELECT 'retail product status history', record_count,
       CASE WHEN record_count = 1 THEN 'READY' ELSE 'MISSING' END
FROM history_check
ORDER BY check_name;

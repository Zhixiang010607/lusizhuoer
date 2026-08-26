WITH checks AS (
  SELECT 1 AS sort_order,
         'purchase table'::TEXT AS check_name,
         CASE WHEN TO_REGCLASS('public.retail_product_purchase_records') IS NOT NULL THEN 1 ELSE 0 END::BIGINT AS record_count,
         CASE WHEN TO_REGCLASS('public.retail_product_purchase_records') IS NOT NULL THEN 'READY' ELSE 'MISSING' END::TEXT AS status

  UNION ALL

  SELECT 2,
         'purchase review function',
         CASE WHEN TO_REGPROCEDURE('public.review_retail_product_purchase(bigint,bigint,text,text)') IS NOT NULL THEN 1 ELSE 0 END::BIGINT,
         CASE WHEN TO_REGPROCEDURE('public.review_retail_product_purchase(bigint,bigint,text,text)') IS NOT NULL THEN 'READY' ELSE 'MISSING' END::TEXT

  UNION ALL

  SELECT 3,
         'purchase indexes',
         COUNT(*)::BIGINT,
         CASE WHEN COUNT(*) >= 4 THEN 'READY' ELSE 'CHECK' END::TEXT
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename = 'retail_product_purchase_records'

  UNION ALL

  SELECT 4,
         'purchase constraints',
         COUNT(*)::BIGINT,
         CASE WHEN COUNT(*) >= 8 THEN 'READY' ELSE 'CHECK' END::TEXT
    FROM pg_constraint
   WHERE conrelid = TO_REGCLASS('public.retail_product_purchase_records')

  UNION ALL

  SELECT 5,
         'purchase guards',
         COUNT(*)::BIGINT,
         CASE WHEN COUNT(*) >= 3 THEN 'READY' ELSE 'CHECK' END::TEXT
    FROM pg_trigger
   WHERE tgrelid = TO_REGCLASS('public.retail_product_purchase_records')
     AND NOT tgisinternal
)
SELECT check_name, record_count, status
  FROM checks
 ORDER BY sort_order;

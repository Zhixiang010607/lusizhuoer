SELECT 'purchase table' AS check_name,
       CASE WHEN TO_REGCLASS('public.retail_product_purchase_records') IS NOT NULL THEN 'READY' ELSE 'MISSING' END AS status;

SELECT 'purchase review function' AS check_name,
       CASE WHEN TO_REGPROCEDURE('public.review_retail_product_purchase(bigint,bigint,text,text)') IS NOT NULL THEN 'READY' ELSE 'MISSING' END AS status;

SELECT 'purchase indexes' AS check_name, COUNT(*) AS record_count,
       CASE WHEN COUNT(*) >= 4 THEN 'READY' ELSE 'CHECK' END AS status
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'retail_product_purchase_records';

SELECT 'purchase constraints' AS check_name, COUNT(*) AS record_count,
       CASE WHEN COUNT(*) >= 8 THEN 'READY' ELSE 'CHECK' END AS status
  FROM pg_constraint
 WHERE conrelid = TO_REGCLASS('public.retail_product_purchase_records');

SELECT 'purchase guards' AS check_name, COUNT(*) AS record_count,
       CASE WHEN COUNT(*) >= 3 THEN 'READY' ELSE 'CHECK' END AS status
  FROM pg_trigger
 WHERE tgrelid = TO_REGCLASS('public.retail_product_purchase_records')
   AND NOT tgisinternal;

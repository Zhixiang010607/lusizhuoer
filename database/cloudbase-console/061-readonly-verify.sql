WITH checks(check_name, ready) AS (
  VALUES
    ('recharge product gifts table', TO_REGCLASS('public.recharge_product_gifts') IS NOT NULL),
    ('gift validation function', TO_REGPROCEDURE('public.validate_recharge_product_gift()') IS NOT NULL),
    ('gift immutability function', TO_REGPROCEDURE('public.prevent_recharge_product_gift_mutation()') IS NOT NULL),
    ('gift validation trigger', EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = TO_REGCLASS('public.recharge_product_gifts')
         AND tgname = 'trg_061_validate_recharge_product_gift' AND NOT tgisinternal
    )),
    ('gift update protection trigger', EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = TO_REGCLASS('public.recharge_product_gifts')
         AND tgname = 'trg_061_prevent_recharge_product_gift_update' AND NOT tgisinternal
    )),
    ('gift delete protection trigger', EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = TO_REGCLASS('public.recharge_product_gifts')
         AND tgname = 'trg_061_prevent_recharge_product_gift_delete' AND NOT tgisinternal
    )),
    ('gift parent-product uniqueness', EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'recharge_product_gifts'
         AND indexdef ILIKE '%(recharge_id, retail_product_id)%'
    )),
    ('gift row-level security', COALESCE((
      SELECT relrowsecurity FROM pg_class WHERE oid = TO_REGCLASS('public.recharge_product_gifts')
    ), FALSE))
)
SELECT check_name, CASE WHEN ready THEN 'READY' ELSE 'MISSING' END AS status
FROM checks
ORDER BY check_name;

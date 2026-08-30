-- Read-only verification for STRESS_10Y_20260830_V1.
-- This file contains no account identity, phone number, secret or destructive SQL.

WITH
checks AS (
  SELECT 'customers exact' AS check_name, COUNT(*)::bigint AS actual, 10959::bigint AS expected
  FROM public.customers
  UNION ALL SELECT 'customer messages exact', COUNT(*), 109590 FROM public.customer_messages
  UNION ALL SELECT 'retail purchases exact', COUNT(*), 21918 FROM public.retail_product_purchase_records
  UNION ALL SELECT 'new recharge exact', COUNT(*), 36530 FROM public.recharge_records WHERE recharge_type = 'NEW'
  UNION ALL SELECT 'refund exact', COUNT(*), 7306 FROM public.recharge_records WHERE recharge_type = 'REFUND'
  UNION ALL SELECT 'verification exact', COUNT(*), 730600 FROM public.verification_records
  UNION ALL SELECT 'teachers exact', COUNT(*), 500 FROM public.teachers
  UNION ALL SELECT 'active teachers exact', COUNT(*), 100 FROM public.teachers WHERE teacher_status = 'ACTIVE'
  UNION ALL SELECT 'archived teachers exact', COUNT(*), 400 FROM public.teachers WHERE teacher_status = 'ARCHIVED'
  UNION ALL SELECT 'stores exact', COUNT(*), 500 FROM public.stores
  UNION ALL SELECT 'active stores exact', COUNT(*), 100 FROM public.stores WHERE store_status = 'ACTIVE'
  UNION ALL SELECT 'archived stores exact', COUNT(*), 400 FROM public.stores WHERE store_status = 'ARCHIVED'
  UNION ALL SELECT 'retail products exact', COUNT(*), 10 FROM public.retail_products
  UNION ALL SELECT 'projects exact', COUNT(*), 3 FROM public.products
  UNION ALL SELECT 'balances exact', COUNT(*), 10959 FROM public.customer_product_balances
  UNION ALL SELECT 'disabled user triggers', COUNT(*), 0
    FROM pg_trigger AS t
    JOIN pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled = 'D'
),
daily_checks AS (
  SELECT 'customers daily 3' AS check_name, COUNT(*)::bigint AS mismatches
  FROM (
    SELECT created_at::date FROM public.customers
    GROUP BY created_at::date HAVING COUNT(*) <> 3
  ) AS q
  UNION ALL SELECT 'new recharge daily 10', COUNT(*) FROM (
    SELECT submitted_at::date FROM public.recharge_records
    WHERE recharge_type = 'NEW'
    GROUP BY submitted_at::date HAVING COUNT(*) <> 10
  ) AS q
  UNION ALL SELECT 'refund daily 2', COUNT(*) FROM (
    SELECT submitted_at::date FROM public.recharge_records
    WHERE recharge_type = 'REFUND'
    GROUP BY submitted_at::date HAVING COUNT(*) <> 2
  ) AS q
  UNION ALL SELECT 'verification daily 200', COUNT(*) FROM (
    SELECT submitted_at::date FROM public.verification_records
    GROUP BY submitted_at::date HAVING COUNT(*) <> 200
  ) AS q
),
relationship_checks AS (
  SELECT 'messages 10/customer' AS check_name, COUNT(*)::bigint AS mismatches
  FROM (
    SELECT c.id FROM public.customers AS c
    LEFT JOIN public.customer_messages AS m ON m.customer_id = c.id
    GROUP BY c.id HAVING COUNT(m.id) <> 10
  ) AS q
  UNION ALL SELECT 'purchases 2/customer', COUNT(*) FROM (
    SELECT c.id FROM public.customers AS c
    LEFT JOIN public.retail_product_purchase_records AS p ON p.customer_id = c.id
    GROUP BY c.id HAVING COUNT(p.id) <> 2
  ) AS q
  UNION ALL SELECT 'purchases 2 distinct products/customer', COUNT(*) FROM (
    SELECT customer_id FROM public.retail_product_purchase_records
    GROUP BY customer_id HAVING COUNT(DISTINCT retail_product_id) <> 2
  ) AS q
  UNION ALL SELECT 'customer recharge cache matches gross NEW', COUNT(*) FROM (
    SELECT c.id
    FROM public.customers AS c
    LEFT JOIN (
      SELECT customer_id, SUM(unit_count)::bigint AS units
      FROM public.recharge_records
      WHERE recharge_type = 'NEW' AND record_status = 'APPROVED'
      GROUP BY customer_id
    ) AS r ON r.customer_id = c.id
    WHERE c.total_recharge_count <> COALESCE(r.units, 0)
  ) AS q
  UNION ALL SELECT 'customer verification cache matches', COUNT(*) FROM (
    SELECT c.id
    FROM public.customers AS c
    LEFT JOIN (
      SELECT customer_id, SUM(unit_count)::bigint AS units
      FROM public.verification_records
      WHERE verification_type IN ('NORMAL', 'SUPPLEMENT') AND record_status = 'APPROVED'
      GROUP BY customer_id
    ) AS v ON v.customer_id = c.id
    WHERE c.total_verification_count <> COALESCE(v.units, 0)
  ) AS q
  UNION ALL SELECT 'balance equation matches gross recharge', COUNT(*) FROM (
    SELECT b.customer_id, b.product_id
    FROM public.customer_product_balances AS b
    LEFT JOIN (
      SELECT customer_id, product_id, SUM(unit_count)::bigint AS units
      FROM public.recharge_records
      WHERE recharge_type = 'NEW' AND record_status = 'APPROVED'
      GROUP BY customer_id, product_id
    ) AS r USING (customer_id, product_id)
    LEFT JOIN (
      SELECT customer_id, product_id, SUM(unit_count)::bigint AS units
      FROM public.verification_records
      WHERE verification_type IN ('NORMAL', 'SUPPLEMENT') AND record_status = 'APPROVED'
      GROUP BY customer_id, product_id
    ) AS v USING (customer_id, product_id)
    WHERE b.total_recharge_count <> COALESCE(r.units, 0)
       OR b.total_verification_count <> COALESCE(v.units, 0)
       OR b.remaining_count <> GREATEST(COALESCE(r.units, 0) - COALESCE(v.units, 0), 0)
  ) AS q
  UNION ALL SELECT 'store account status matches', COUNT(*)
  FROM public.stores AS s
  JOIN public.staff_accounts AS a ON a.id = s.store_account_id
  WHERE a.account_status <> s.store_status
  UNION ALL SELECT 'teacher account status matches', COUNT(*)
  FROM public.teachers AS t
  JOIN public.staff_accounts AS a ON a.id = t.staff_account_id
  WHERE a.account_status <> t.teacher_status
  UNION ALL SELECT 'primary contact status matches', COUNT(*)
  FROM public.stores AS s
  JOIN public.store_contacts AS c ON c.store_id = s.id AND c.is_primary
  WHERE c.contact_status <> s.store_status
),
range_checks AS (
  SELECT 'customers range and 3653 days' AS check_name,
    MIN(created_at)::date = DATE '2016-08-30'
    AND MAX(created_at)::date = DATE '2026-08-30'
    AND COUNT(DISTINCT created_at::date) = 3653 AS ok
  FROM public.customers
  UNION ALL SELECT 'new recharge range and 3653 days',
    MIN(submitted_at)::date = DATE '2016-08-30'
    AND MAX(submitted_at)::date = DATE '2026-08-30'
    AND COUNT(DISTINCT submitted_at::date) = 3653
  FROM public.recharge_records WHERE recharge_type = 'NEW'
  UNION ALL SELECT 'refund range and 3653 days',
    MIN(submitted_at)::date = DATE '2016-08-30'
    AND MAX(submitted_at)::date = DATE '2026-08-30'
    AND COUNT(DISTINCT submitted_at::date) = 3653
  FROM public.recharge_records WHERE recharge_type = 'REFUND'
  UNION ALL SELECT 'verification range and 3653 days',
    MIN(submitted_at)::date = DATE '2016-08-30'
    AND MAX(submitted_at)::date = DATE '2026-08-30'
    AND COUNT(DISTINCT submitted_at::date) = 3653
  FROM public.verification_records
),
project_checks AS (
  SELECT 'three required project codes' AS check_name,
    COUNT(*) = 3
    AND COUNT(*) FILTER (WHERE product_code IN ('PRD001', 'PRD002', 'PRD003')) = 3 AS ok
  FROM public.products
)
SELECT check_name, actual, expected,
       CASE WHEN actual = expected THEN 'READY' ELSE 'CHECK' END AS status
FROM checks
UNION ALL
SELECT check_name, mismatches, 0,
       CASE WHEN mismatches = 0 THEN 'READY' ELSE 'CHECK' END
FROM daily_checks
UNION ALL
SELECT check_name, mismatches, 0,
       CASE WHEN mismatches = 0 THEN 'READY' ELSE 'CHECK' END
FROM relationship_checks
UNION ALL
SELECT check_name, ok::integer, 1,
       CASE WHEN ok THEN 'READY' ELSE 'CHECK' END
FROM range_checks
UNION ALL
SELECT check_name, ok::integer, 1,
       CASE WHEN ok THEN 'READY' ELSE 'CHECK' END
FROM project_checks
ORDER BY check_name;

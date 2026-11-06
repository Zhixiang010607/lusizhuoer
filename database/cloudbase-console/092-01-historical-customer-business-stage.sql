-- 092: Historical customer business stage. Does not change balances or orders.
-- Production: preview first, then execute through scripts/cloudbase-pg-change.js.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$
BEGIN
  IF TO_REGPROCEDURE('public.refresh_customer_balance(bigint)') IS NULL THEN
    RAISE EXCEPTION '092 requires the existing customer balance refresh function';
  END IF;
END;
$$;
LOCK TABLE public.recharge_records, public.verification_records, public.customers
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.refresh_customer_balance(p_customer_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM public.customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer % does not exist', p_customer_id; END IF;

  DELETE FROM public.customer_product_balances WHERE customer_id = p_customer_id;

  INSERT INTO public.customer_product_balances
    (customer_id, product_id, total_recharge_count, total_verification_count, remaining_count, updated_at)
  WITH recharge_totals AS (
    SELECT customer_id, product_id,
           GREATEST(SUM(CASE WHEN recharge_type = 'NEW' THEN unit_count ELSE -unit_count END), 0)::INTEGER AS purchased_count
      FROM public.recharge_records
     WHERE customer_id = p_customer_id AND record_status = 'APPROVED'
     GROUP BY customer_id, product_id
  ), verification_totals AS (
    SELECT customer_id, product_id, SUM(unit_count)::INTEGER AS consumed_count
      FROM public.verification_records
     WHERE customer_id = p_customer_id
       AND record_status = 'APPROVED'
       AND verification_type IN ('NORMAL', 'SUPPLEMENT')
     GROUP BY customer_id, product_id
  )
  SELECT COALESCE(r.customer_id, v.customer_id),
         COALESCE(r.product_id, v.product_id),
         COALESCE(r.purchased_count, 0),
         COALESCE(v.consumed_count, 0),
         GREATEST(COALESCE(r.purchased_count, 0) - COALESCE(v.consumed_count, 0), 0),
         NOW()
    FROM recharge_totals r
    FULL OUTER JOIN verification_totals v
      ON r.customer_id = v.customer_id AND r.product_id = v.product_id
   WHERE COALESCE(r.purchased_count, 0) <> 0 OR COALESCE(v.consumed_count, 0) <> 0;

  UPDATE public.customers c
     SET total_recharge_count = COALESCE((
           SELECT SUM(b.total_recharge_count) FROM public.customer_product_balances b WHERE b.customer_id = c.id
         ), 0),
         total_verification_count = COALESCE((
           SELECT SUM(v.unit_count) FROM public.verification_records v
            WHERE v.customer_id = c.id AND v.record_status = 'APPROVED'
              AND v.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')
         ), 0),
         total_experience_count = COALESCE((
           SELECT SUM(v.unit_count) FROM public.verification_records v
            WHERE v.customer_id = c.id AND v.record_status = 'APPROVED' AND v.verification_type = 'EXPERIENCE'
         ), 0),
         latest_recharge_at = (
           SELECT MAX(r.submitted_at) FROM public.recharge_records r
            WHERE r.customer_id = c.id AND r.record_status = 'APPROVED' AND r.recharge_type = 'NEW'
         ),
         latest_verification_at = (
           SELECT MAX(v.submitted_at) FROM public.verification_records v
            WHERE v.customer_id = c.id AND v.record_status = 'APPROVED'
              AND v.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')
         ),
         customer_process_status = CASE
           WHEN NOT EXISTS (SELECT 1 FROM public.recharge_records r
                            WHERE r.customer_id = c.id AND r.record_status = 'APPROVED' AND r.recharge_type = 'NEW')
             THEN 'INFORMATION_ONLY'
           WHEN NOT EXISTS (SELECT 1 FROM public.verification_records v
                            WHERE v.customer_id = c.id AND v.record_status = 'APPROVED'
                              AND v.verification_type IN ('NORMAL', 'SUPPLEMENT'))
             THEN 'RECHARGED_NO_CONSUMPTION'
           ELSE 'RECHARGED_WITH_CONSUMPTION'
         END
   WHERE c.id = p_customer_id;
END;
$$;

-- Only the derived stage is backfilled. No call to refresh_customer_balance:
-- existing balances, audit timestamps, ledgers and customer totals stay intact.
WITH expected AS (
  SELECT c.id, CASE
    WHEN NOT EXISTS (SELECT 1 FROM public.recharge_records r
                     WHERE r.customer_id = c.id AND r.record_status = 'APPROVED' AND r.recharge_type = 'NEW')
      THEN 'INFORMATION_ONLY'
    WHEN NOT EXISTS (SELECT 1 FROM public.verification_records v
                     WHERE v.customer_id = c.id AND v.record_status = 'APPROVED'
                       AND v.verification_type IN ('NORMAL', 'SUPPLEMENT'))
      THEN 'RECHARGED_NO_CONSUMPTION'
    ELSE 'RECHARGED_WITH_CONSUMPTION'
  END AS stage
  FROM public.customers c
)
UPDATE public.customers c
   SET customer_process_status = e.stage
  FROM expected e
 WHERE c.id = e.id AND c.customer_process_status IS DISTINCT FROM e.stage;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.customers c WHERE c.customer_process_status IS DISTINCT FROM CASE
    WHEN NOT EXISTS (SELECT 1 FROM public.recharge_records r
                     WHERE r.customer_id = c.id AND r.record_status = 'APPROVED' AND r.recharge_type = 'NEW')
      THEN 'INFORMATION_ONLY'
    WHEN NOT EXISTS (SELECT 1 FROM public.verification_records v
                     WHERE v.customer_id = c.id AND v.record_status = 'APPROVED'
                       AND v.verification_type IN ('NORMAL', 'SUPPLEMENT'))
      THEN 'RECHARGED_NO_CONSUMPTION'
    ELSE 'RECHARGED_WITH_CONSUMPTION'
  END
  ) THEN RAISE EXCEPTION '092 customer business stage reconciliation failed'; END IF;
END;
$$;
COMMENT ON FUNCTION public.refresh_customer_balance(BIGINT) IS
  'Net purchased balances remain unchanged; customer business stage uses historical approved NEW and NORMAL/SUPPLEMENT, excluding experience, refunds and pending/rejected records.';
COMMIT;

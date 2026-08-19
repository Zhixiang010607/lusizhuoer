-- Migration 044, CloudBase SQL console part 1 of 2.
-- Execute part 1 first, then part 2.

BEGIN;

DO $$
BEGIN
  IF TO_REGPROCEDURE('public.refresh_customer_balance(bigint)') IS NULL
     OR TO_REGPROCEDURE('public.review_order_application(character varying,bigint,bigint,character varying,text)') IS NULL THEN
    RAISE EXCEPTION 'migrations 021 and 028 must be executed before migration 044';
  END IF;
END;
$$;

LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.customer_product_balances IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.recharge_records
  ADD COLUMN IF NOT EXISTS balance_before_count INTEGER,
  ADD COLUMN IF NOT EXISTS balance_after_count INTEGER;

-- Constraint names differ between the incremental and rebuilt schemas. Drop
-- only checks that directly constrain recharge_type/original_recharge_id, then
-- install stable names for NEW, historical VOID, and REFUND records.
DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.recharge_records'::regclass
       AND contype = 'c'
       AND (PG_GET_CONSTRAINTDEF(oid) ILIKE '%recharge_type%'
            OR PG_GET_CONSTRAINTDEF(oid) ILIKE '%original_recharge_id%')
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.recharge_records DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END;
$$;

ALTER TABLE public.recharge_records
  ADD CONSTRAINT recharge_records_type_check
    CHECK (recharge_type IN ('NEW', 'VOID', 'REFUND')),
  ADD CONSTRAINT recharge_records_type_origin_check
    CHECK (
      (recharge_type IN ('NEW', 'REFUND') AND original_recharge_id IS NULL)
      OR (recharge_type = 'VOID' AND original_recharge_id IS NOT NULL)
    ),
  ADD CONSTRAINT recharge_records_refund_snapshot_check
    CHECK (
      (recharge_type = 'REFUND' AND balance_before_count IS NOT NULL AND balance_before_count >= 0)
      OR (recharge_type <> 'REFUND' AND balance_before_count IS NULL AND balance_after_count IS NULL)
    ),
  ADD CONSTRAINT recharge_records_refund_after_check
    CHECK (
      balance_after_count IS NULL
      OR (recharge_type = 'REFUND' AND record_status = 'APPROVED' AND balance_after_count >= 0)
    );

ALTER TABLE public.customer_product_balances
  DROP CONSTRAINT IF EXISTS customer_product_balances_count_equation;

ALTER TABLE public.customer_product_balances
  ADD CONSTRAINT customer_product_balances_count_equation
  CHECK (remaining_count = GREATEST(total_recharge_count - total_verification_count, 0));

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
           WHEN COALESCE((SELECT SUM(b.total_recharge_count) FROM public.customer_product_balances b WHERE b.customer_id = c.id), 0) = 0
             THEN 'INFORMATION_ONLY'
           WHEN COALESCE((SELECT SUM(b.total_verification_count) FROM public.customer_product_balances b WHERE b.customer_id = c.id), 0) = 0
             THEN 'RECHARGED_NO_CONSUMPTION'
           ELSE 'RECHARGED_WITH_CONSUMPTION'
         END
   WHERE c.id = p_customer_id;
END;
$$;

COMMIT;

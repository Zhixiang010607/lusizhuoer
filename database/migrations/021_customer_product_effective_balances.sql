BEGIN;

-- This table is the authoritative per-customer, per-product balance.  It never
-- contains customer phone numbers or product prices.
LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.customer_product_balances IN SHARE ROW EXCLUSIVE MODE;

COMMENT ON TABLE public.customer_product_balances IS
  'Approved purchased units and paid-service consumption for each customer and product.';
COMMENT ON COLUMN public.customer_product_balances.total_recharge_count IS
  'Net approved purchased units: approved NEW recharge units minus approved VOID recharge units.';
COMMENT ON COLUMN public.customer_product_balances.total_verification_count IS
  'Approved consumptive verification units. Only NORMAL and SUPPLEMENT count; EXPERIENCE never consumes a purchased unit and VOIDED originals are not approved.';
COMMENT ON COLUMN public.customer_product_balances.remaining_count IS
  'Available units: total_recharge_count minus total_verification_count.';

CREATE OR REPLACE FUNCTION public.refresh_customer_balance(p_customer_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- All balance changes for one customer serialize on this row.  This prevents
  -- two concurrent approvals from both spending the same final unit.
  PERFORM 1
  FROM public.customers
  WHERE id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer % does not exist', p_customer_id;
  END IF;

  -- Refuse the entire order transaction before publishing an impossible
  -- balance. Pending/rejected/voided orders have no effect. EXPERIENCE
  -- verification records are deliberately absent from verification_totals.
  IF EXISTS (
    WITH recharge_totals AS (
      SELECT product_id,
             SUM(CASE recharge_type WHEN 'NEW' THEN unit_count ELSE -unit_count END)::INTEGER AS purchased_count
      FROM public.recharge_records
      WHERE customer_id = p_customer_id
        AND record_status = 'APPROVED'
      GROUP BY product_id
    ), verification_totals AS (
      SELECT product_id, SUM(unit_count)::INTEGER AS consumed_count
      FROM public.verification_records
      WHERE customer_id = p_customer_id
        AND record_status = 'APPROVED'
        AND verification_type IN ('NORMAL', 'SUPPLEMENT')
      GROUP BY product_id
    )
    SELECT 1
    FROM recharge_totals r
    FULL OUTER JOIN verification_totals v USING (product_id)
    WHERE COALESCE(r.purchased_count, 0) < COALESCE(v.consumed_count, 0)
  ) THEN
    RAISE EXCEPTION 'insufficient purchased units for customer %', p_customer_id
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.customer_product_balances
  WHERE customer_id = p_customer_id;

  INSERT INTO public.customer_product_balances
    (customer_id, product_id, total_recharge_count, total_verification_count, remaining_count, updated_at)
  WITH recharge_totals AS (
    SELECT customer_id, product_id,
           SUM(CASE recharge_type WHEN 'NEW' THEN unit_count ELSE -unit_count END)::INTEGER AS purchased_count
    FROM public.recharge_records
    WHERE customer_id = p_customer_id
      AND record_status = 'APPROVED'
    GROUP BY customer_id, product_id
  ), verification_totals AS (
    SELECT customer_id, product_id, SUM(unit_count)::INTEGER AS consumed_count
    FROM public.verification_records
    WHERE customer_id = p_customer_id
      AND record_status = 'APPROVED'
      AND verification_type IN ('NORMAL', 'SUPPLEMENT')
    GROUP BY customer_id, product_id
  )
  SELECT
    COALESCE(r.customer_id, v.customer_id),
    COALESCE(r.product_id, v.product_id),
    COALESCE(r.purchased_count, 0),
    COALESCE(v.consumed_count, 0),
    COALESCE(r.purchased_count, 0) - COALESCE(v.consumed_count, 0),
    NOW()
  FROM recharge_totals r
  FULL OUTER JOIN verification_totals v
    ON r.customer_id = v.customer_id
   AND r.product_id = v.product_id
  WHERE COALESCE(r.purchased_count, 0) <> 0
     OR COALESCE(v.consumed_count, 0) <> 0;

  UPDATE public.customers c
  SET
    total_recharge_count = COALESCE((
      SELECT SUM(b.total_recharge_count)
      FROM public.customer_product_balances b
      WHERE b.customer_id = c.id
    ), 0),
    -- The customer-wide count keeps the previously agreed business meaning:
    -- all approved NORMAL/SUPPLEMENT/EXPERIENCE services. The per-product
    -- balance above counts only services that consume purchased units.
    total_verification_count = COALESCE((
      SELECT SUM(v.unit_count)
      FROM public.verification_records v
      WHERE v.customer_id = c.id
        AND v.record_status = 'APPROVED'
        AND v.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')
    ), 0),
    total_experience_count = COALESCE((
      SELECT SUM(v.unit_count)
      FROM public.verification_records v
      WHERE v.customer_id = c.id
        AND v.record_status = 'APPROVED'
        AND v.verification_type = 'EXPERIENCE'
    ), 0),
    latest_recharge_at = (
      SELECT MAX(r.submitted_at)
      FROM public.recharge_records r
      WHERE r.customer_id = c.id AND r.record_status = 'APPROVED'
    ),
    latest_verification_at = (
      SELECT MAX(v.submitted_at)
      FROM public.verification_records v
      WHERE v.customer_id = c.id
        AND v.record_status = 'APPROVED'
        AND v.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')
    ),
    customer_process_status = CASE
      WHEN COALESCE((
        SELECT SUM(b.total_recharge_count)
        FROM public.customer_product_balances b
        WHERE b.customer_id = c.id
      ), 0) = 0 THEN 'INFORMATION_ONLY'
      WHEN COALESCE((
        SELECT SUM(b.total_verification_count)
        FROM public.customer_product_balances b
        WHERE b.customer_id = c.id
      ), 0) = 0 THEN 'RECHARGED_NO_CONSUMPTION'
      ELSE 'RECHARGED_WITH_CONSUMPTION'
    END
  WHERE c.id = p_customer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_customer_balance_after_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.refresh_customer_balance(COALESCE(NEW.customer_id, OLD.customer_id));
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recharge_refresh_customer_balance
ON public.recharge_records;
CREATE TRIGGER trg_recharge_refresh_customer_balance
AFTER INSERT OR UPDATE OR DELETE
ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.refresh_customer_balance_after_order();

DROP TRIGGER IF EXISTS trg_verification_refresh_customer_balance
ON public.verification_records;
CREATE TRIGGER trg_verification_refresh_customer_balance
AFTER INSERT OR UPDATE OR DELETE
ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.refresh_customer_balance_after_order();

-- Rebuild existing summaries once with the corrected rules. Running this
-- migration again is safe: the function derives the same result from orders.
DO $$
DECLARE
  customer_row RECORD;
BEGIN
  FOR customer_row IN SELECT id FROM public.customers ORDER BY id LOOP
    PERFORM public.refresh_customer_balance(customer_row.id);
  END LOOP;
END;
$$;

ALTER TABLE public.customer_product_balances
  DROP CONSTRAINT IF EXISTS customer_product_balances_count_equation;

ALTER TABLE public.customer_product_balances
  ADD CONSTRAINT customer_product_balances_count_equation
  CHECK (remaining_count = total_recharge_count - total_verification_count);

ALTER TABLE public.customer_product_balances ENABLE ROW LEVEL SECURITY;

COMMIT;

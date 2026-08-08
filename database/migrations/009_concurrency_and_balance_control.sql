-- Concurrency, idempotency, and customer-product balance control.
-- Run after the final schema.  All SQL text is ASCII-only.

BEGIN;

ALTER TABLE public.recharge_records
  ADD COLUMN IF NOT EXISTS unit_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

ALTER TABLE public.verification_records
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

ALTER TABLE public.recharge_records
  DROP CONSTRAINT IF EXISTS recharge_records_unit_count_check;
ALTER TABLE public.recharge_records
  ADD CONSTRAINT recharge_records_unit_count_check CHECK (unit_count > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recharge_idempotency_key
  ON public.recharge_records (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_idempotency_key
  ON public.verification_records (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.customer_product_balances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  approved_recharge_units BIGINT NOT NULL DEFAULT 0 CHECK (approved_recharge_units >= 0),
  approved_verification_units BIGINT NOT NULL DEFAULT 0 CHECK (approved_verification_units >= 0),
  remaining_units BIGINT NOT NULL DEFAULT 0 CHECK (remaining_units >= 0),
  row_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, store_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_product_balance_lookup
  ON public.customer_product_balances (customer_id, store_id, product_id);

CREATE OR REPLACE FUNCTION public.touch_customer_product_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.row_version = OLD.row_version + 1;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_recharge_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.record_status = 'APPROVED' THEN
      INSERT INTO public.customer_product_balances
        (customer_id, store_id, product_id, approved_recharge_units, remaining_units)
      VALUES (NEW.customer_id, NEW.store_id, NEW.product_id, NEW.unit_count, NEW.unit_count)
      ON CONFLICT (customer_id, store_id, product_id)
      DO UPDATE SET
        approved_recharge_units = customer_product_balances.approved_recharge_units + EXCLUDED.approved_recharge_units,
        remaining_units = customer_product_balances.remaining_units + EXCLUDED.remaining_units;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.record_status = 'PENDING' AND NEW.record_status = 'APPROVED' THEN
    INSERT INTO public.customer_product_balances
      (customer_id, store_id, product_id, approved_recharge_units, remaining_units)
    VALUES (NEW.customer_id, NEW.store_id, NEW.product_id, NEW.unit_count, NEW.unit_count)
    ON CONFLICT (customer_id, store_id, product_id)
    DO UPDATE SET
      approved_recharge_units = customer_product_balances.approved_recharge_units + EXCLUDED.approved_recharge_units,
      remaining_units = customer_product_balances.remaining_units + EXCLUDED.remaining_units;
  ELSIF OLD.record_status = 'APPROVED' AND NEW.record_status = 'REJECTED' THEN
    UPDATE public.customer_product_balances
    SET approved_recharge_units = approved_recharge_units - OLD.unit_count,
        remaining_units = remaining_units - OLD.unit_count
    WHERE customer_id = OLD.customer_id
      AND store_id = OLD.store_id
      AND product_id = OLD.product_id
      AND remaining_units >= OLD.unit_count;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cannot reject recharge after consumed units exist';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_verification_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.record_status = 'APPROVED' THEN
      UPDATE public.customer_product_balances
      SET approved_verification_units = approved_verification_units + 1,
          remaining_units = remaining_units - 1
      WHERE customer_id = NEW.customer_id
        AND store_id = NEW.store_id
        AND product_id = NEW.product_id
        AND remaining_units >= 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'insufficient remaining units for verification';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.record_status = 'PENDING' AND NEW.record_status = 'APPROVED' THEN
    UPDATE public.customer_product_balances
    SET approved_verification_units = approved_verification_units + 1,
        remaining_units = remaining_units - 1
    WHERE customer_id = NEW.customer_id
      AND store_id = NEW.store_id
      AND product_id = NEW.product_id
      AND remaining_units >= 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insufficient remaining units for verification';
    END IF;
  ELSIF OLD.record_status = 'APPROVED' AND NEW.record_status = 'REJECTED' THEN
    UPDATE public.customer_product_balances
    SET approved_verification_units = approved_verification_units - 1,
        remaining_units = remaining_units + 1
    WHERE customer_id = OLD.customer_id
      AND store_id = OLD.store_id
      AND product_id = OLD.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'verification balance row not found';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_customer_product_balance ON public.customer_product_balances;
CREATE TRIGGER trg_touch_customer_product_balance
BEFORE UPDATE ON public.customer_product_balances
FOR EACH ROW EXECUTE FUNCTION public.touch_customer_product_balance();

DROP TRIGGER IF EXISTS trg_apply_recharge_balance ON public.recharge_records;
CREATE TRIGGER trg_apply_recharge_balance
AFTER INSERT OR UPDATE OF record_status ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.apply_recharge_balance();

DROP TRIGGER IF EXISTS trg_apply_verification_balance ON public.verification_records;
CREATE TRIGGER trg_apply_verification_balance
AFTER INSERT OR UPDATE OF record_status ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.apply_verification_balance();

INSERT INTO public.customer_product_balances
  (customer_id, store_id, product_id, approved_recharge_units, approved_verification_units, remaining_units)
SELECT
  r.customer_id,
  r.store_id,
  r.product_id,
  COALESCE(SUM(r.unit_count) FILTER (WHERE r.record_status = 'APPROVED'), 0),
  COALESCE(v.approved_units, 0),
  GREATEST(COALESCE(SUM(r.unit_count) FILTER (WHERE r.record_status = 'APPROVED'), 0) - COALESCE(v.approved_units, 0), 0)
FROM public.recharge_records r
LEFT JOIN (
  SELECT customer_id, store_id, product_id, COUNT(*) AS approved_units
  FROM public.verification_records
  WHERE record_status = 'APPROVED'
  GROUP BY customer_id, store_id, product_id
) v ON v.customer_id = r.customer_id AND v.store_id = r.store_id AND v.product_id = r.product_id
WHERE r.product_id IS NOT NULL
GROUP BY r.customer_id, r.store_id, r.product_id, v.approved_units
ON CONFLICT (customer_id, store_id, product_id) DO NOTHING;

ALTER TABLE public.customer_product_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_product_balance_scoped_read ON public.customer_product_balances;
CREATE POLICY customer_product_balance_scoped_read
ON public.customer_product_balances
FOR SELECT TO authenticated
USING (
  public.has_store_scope(store_id)
  OR EXISTS (
    SELECT 1 FROM public.recharge_records r
    WHERE r.customer_id = customer_product_balances.customer_id
      AND r.store_id = customer_product_balances.store_id
      AND r.product_id = customer_product_balances.product_id
      AND r.teacher_id = public.current_teacher_id()
  )
);

COMMIT;

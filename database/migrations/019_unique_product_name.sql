BEGIN;

LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.products
    GROUP BY LOWER(BTRIM(product_name))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate normalized product names exist. Resolve them before applying migration 019.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_normalized_name
  ON public.products (LOWER(BTRIM(product_name)));

COMMIT;

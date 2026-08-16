BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.product_code_seq START WITH 1;

LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  max_product_code BIGINT;
  current_sequence BIGINT;
  sequence_called BOOLEAN;
BEGIN
  SELECT COALESCE(MAX(trailing_number), 0)
  INTO max_product_code
  FROM (
    SELECT substring(product_code FROM '([0-9]+)$')::NUMERIC AS trailing_number
    FROM public.products
    WHERE product_code ~ '[0-9]+$'
  ) AS product_numbers
  WHERE trailing_number <= 9223372036854775806;

  SELECT last_value, is_called
  INTO current_sequence, sequence_called
  FROM public.product_code_seq;

  IF max_product_code > 0 THEN
    PERFORM setval(
      'public.product_code_seq',
      GREATEST(max_product_code, current_sequence),
      TRUE
    );
  ELSIF sequence_called THEN
    PERFORM setval('public.product_code_seq', GREATEST(current_sequence, 1), TRUE);
  ELSE
    PERFORM setval('public.product_code_seq', GREATEST(current_sequence, 1), FALSE);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_product_code()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  code_number BIGINT;
BEGIN
  code_number := nextval('public.product_code_seq');
  RETURN 'PRD' || LPAD(
    code_number::TEXT,
    GREATEST(3, LENGTH(code_number::TEXT)),
    '0'
  );
END;
$$;

ALTER TABLE public.products
  ALTER COLUMN product_code
    SET DEFAULT public.next_product_code(),
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

UPDATE public.products
SET description = ''
WHERE description IS NULL;

ALTER TABLE public.products
  ALTER COLUMN description SET DEFAULT '',
  ALTER COLUMN description SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_idempotency_key
  ON public.products (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;

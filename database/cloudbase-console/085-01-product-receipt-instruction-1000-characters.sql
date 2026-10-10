-- Migration 085: limit each project receipt instruction to 1000 Unicode characters.
-- PostgreSQL TEXT preserves explicit newlines, emoji, and other UTF-8 symbols.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.products') IS NULL THEN
    RAISE EXCEPTION 'migration 085 requires public.products';
  END IF;
END;
$$;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_receipt_instruction_length_check;

ALTER TABLE public.products
  ADD CONSTRAINT products_receipt_instruction_length_check CHECK (
    CHAR_LENGTH(verification_receipt_instructions) <= 1000
    AND CHAR_LENGTH(recharge_receipt_instructions) <= 1000
  ) NOT VALID;

COMMENT ON CONSTRAINT products_receipt_instruction_length_check ON public.products IS
  'Migration 085: each receipt instruction preserves UTF-8 and explicit newlines, up to 1000 characters.';

COMMIT;

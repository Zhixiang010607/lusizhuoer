-- Customer approved-record totals.
-- Run after the customer base schema. All SQL text is ASCII-only.

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS total_recharge_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_verification_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_experience_count INTEGER NOT NULL DEFAULT 0;

UPDATE public.customers
SET total_recharge_count = 0
WHERE total_recharge_count IS NULL;

UPDATE public.customers
SET total_verification_count = 0
WHERE total_verification_count IS NULL;

UPDATE public.customers
SET total_experience_count = 0
WHERE total_experience_count IS NULL;

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_total_recharge_count_check,
  DROP CONSTRAINT IF EXISTS customers_total_verification_count_check,
  DROP CONSTRAINT IF EXISTS customers_total_experience_count_check;

ALTER TABLE public.customers
  ADD CONSTRAINT customers_total_recharge_count_check CHECK (total_recharge_count >= 0),
  ADD CONSTRAINT customers_total_verification_count_check CHECK (total_verification_count >= 0),
  ADD CONSTRAINT customers_total_experience_count_check CHECK (total_experience_count >= 0);

COMMIT;

-- Customer lifecycle and timestamps.
-- Run after the base customer schema. All SQL text is ASCII-only.

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS customer_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS customer_process_status VARCHAR(32) NOT NULL DEFAULT 'INFORMATION_ONLY',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE public.customers
SET customer_process_status = 'INFORMATION_ONLY'
WHERE customer_process_status IS NULL;

UPDATE public.customers
SET customer_status = 'ACTIVE'
WHERE customer_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_customer_status_process
  ON public.customers (customer_status, customer_process_status);

COMMIT;

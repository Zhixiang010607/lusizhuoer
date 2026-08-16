-- Customer business stage values.
-- Run after 011_customer_status_fields.sql. All SQL text is ASCII-only.

BEGIN;

UPDATE public.customers
SET customer_process_status = 'INFORMATION_ONLY'
WHERE customer_process_status IS NULL
   OR customer_process_status = 'PROFILE_CREATED';

ALTER TABLE public.customers
  ALTER COLUMN customer_process_status SET DEFAULT 'INFORMATION_ONLY';

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_customer_process_status_check;

ALTER TABLE public.customers
  ADD CONSTRAINT customers_customer_process_status_check
  CHECK (customer_process_status IN ('INFORMATION_ONLY', 'RECHARGED_NO_CONSUMPTION', 'RECHARGED_WITH_CONSUMPTION'));

COMMIT;

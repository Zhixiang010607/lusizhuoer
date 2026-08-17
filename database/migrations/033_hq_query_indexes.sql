-- Global cursor indexes for headquarters customer, recharge, and verification queries.
-- This migration adds indexes only; it does not change tables, data, or permissions.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_customers_hq_created_cursor
  ON public.customers (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_customers_hq_process_created_cursor
  ON public.customers (customer_process_status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_customers_hq_status_created_cursor
  ON public.customers (customer_status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_customers_hq_birth_created_cursor
  ON public.customers (birth_date, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_customers_store_birth_created_cursor
  ON public.customers (created_store_id, birth_date, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_recharge_hq_cursor
  ON public.recharge_records (submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_hq_status_cursor
  ON public.recharge_records (record_status, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_hq_product_cursor
  ON public.recharge_records (product_id, submitted_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_verification_hq_cursor
  ON public.verification_records (submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_hq_status_cursor
  ON public.verification_records (record_status, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_hq_product_cursor
  ON public.verification_records (product_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_hq_type_cursor
  ON public.verification_records (verification_type, submitted_at DESC, id DESC);

ANALYZE public.customers;
ANALYZE public.recharge_records;
ANALYZE public.verification_records;

COMMIT;

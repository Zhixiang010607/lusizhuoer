-- Fast, server-scoped customer queries for store users.
-- Run once in the CloudBase PostgreSQL SQL editor.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_customers_store_created_cursor
  ON public.customers (created_store_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_customers_store_process_created_cursor
  ON public.customers (created_store_id, customer_process_status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_customers_store_status_created_cursor
  ON public.customers (created_store_id, customer_status, created_at DESC, id DESC);

-- Existing idx_customers_active_store_lookup supports the exact name/date
-- path; this index supports case-insensitive partial-name searches as well.
CREATE INDEX IF NOT EXISTS idx_customers_store_name_lower
  ON public.customers (created_store_id, lower(customer_name));

ANALYZE public.customers;
COMMIT;

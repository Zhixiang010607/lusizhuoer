-- Canonical large-table indexes for recharge and verification workloads.
-- Run this migration before the order tables become large. All SQL is ASCII-only.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_customers_active_store_lookup
  ON public.customers (created_store_id, customer_name, birth_date, id)
  WHERE customer_status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_recharge_customer_cursor
  ON public.recharge_records (customer_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_store_cursor
  ON public.recharge_records (store_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_teacher_cursor
  ON public.recharge_records (teacher_id, submitted_at DESC, id DESC)
  WHERE teacher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recharge_pending_review_cursor
  ON public.recharge_records (submitted_at DESC, id DESC)
  WHERE record_status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_recharge_approved_balance
  ON public.recharge_records (customer_id, product_id, recharge_type)
  INCLUDE (unit_count, submitted_at)
  WHERE record_status = 'APPROVED';
CREATE INDEX IF NOT EXISTS idx_recharge_product_store_cursor
  ON public.recharge_records (product_id, store_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_product_teacher_cursor
  ON public.recharge_records (product_id, teacher_id, submitted_at DESC, id DESC)
  WHERE teacher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recharge_submitted_brin
  ON public.recharge_records USING BRIN (submitted_at) WITH (pages_per_range = 128);

CREATE INDEX IF NOT EXISTS idx_verification_customer_cursor
  ON public.verification_records (customer_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_store_cursor
  ON public.verification_records (store_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_teacher_cursor
  ON public.verification_records (teacher_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_pending_review_cursor
  ON public.verification_records (submitted_at DESC, id DESC)
  WHERE record_status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_verification_approved_balance
  ON public.verification_records (customer_id, product_id, verification_type)
  INCLUDE (unit_count, submitted_at)
  WHERE record_status = 'APPROVED';
CREATE INDEX IF NOT EXISTS idx_verification_product_store_cursor
  ON public.verification_records (product_id, store_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_product_teacher_cursor
  ON public.verification_records (product_id, teacher_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_submitted_brin
  ON public.verification_records USING BRIN (submitted_at) WITH (pages_per_range = 128);

CREATE INDEX IF NOT EXISTS idx_customer_product_balances_product
  ON public.customer_product_balances (product_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_history_record_cursor
  ON public.record_status_history (record_type, record_id, changed_at DESC, id DESC);

-- Remove prefix-equivalent legacy indexes after the cursor-safe replacements
-- exist. This avoids duplicate write and storage cost on million-row tables.
DROP INDEX IF EXISTS public.idx_recharge_customer_time;
DROP INDEX IF EXISTS public.idx_recharge_store_time;
DROP INDEX IF EXISTS public.idx_recharge_teacher_time;
DROP INDEX IF EXISTS public.idx_recharge_product_store_time;
DROP INDEX IF EXISTS public.idx_recharge_product_teacher_time;
DROP INDEX IF EXISTS public.idx_verification_customer_time;
DROP INDEX IF EXISTS public.idx_verification_store_time;
DROP INDEX IF EXISTS public.idx_verification_teacher_time;
DROP INDEX IF EXISTS public.idx_verification_product_store_time;
DROP INDEX IF EXISTS public.idx_verification_product_teacher_time;
DROP INDEX IF EXISTS public.idx_history_lookup;

COMMENT ON COLUMN public.customers.profile_photo_file_id IS
  'Private CloudBase Storage object reference only. Never store image bytes, base64 data, or a signed public URL here.';
COMMENT ON COLUMN public.verification_records.face_request_id IS
  'Tencent face API request identifier only. Live verification image bytes are not retained in PostgreSQL.';

ANALYZE public.customers;
ANALYZE public.recharge_records;
ANALYZE public.verification_records;
ANALYZE public.customer_product_balances;
ANALYZE public.record_status_history;

COMMIT;

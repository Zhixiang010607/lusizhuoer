-- Customer profile photo retention and enrollment audit fields.
-- Run after schema.full.sql. All SQL text is ASCII-only.

BEGIN;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS birth_date DATE,
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS profile_photo_file_id VARCHAR(512),
  ADD COLUMN IF NOT EXISTS photo_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customer_store_name_birth_active
  ON public.customers (created_store_id, customer_name, birth_date)
  WHERE customer_status = 'ACTIVE';

COMMIT;

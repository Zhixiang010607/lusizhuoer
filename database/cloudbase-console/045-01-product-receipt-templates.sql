-- Run once in the CloudBase PostgreSQL SQL console.
BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS receipt_logo_file_id VARCHAR(768),
  ADD COLUMN IF NOT EXISTS receipt_logo_mime_type VARCHAR(64),
  ADD COLUMN IF NOT EXISTS receipt_logo_original_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS receipt_logo_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS receipt_logo_width INTEGER,
  ADD COLUMN IF NOT EXISTS receipt_logo_height INTEGER,
  ADD COLUMN IF NOT EXISTS verification_receipt_instructions TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recharge_receipt_instructions TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS receipt_template_updated_by BIGINT REFERENCES public.staff_accounts(id),
  ADD COLUMN IF NOT EXISTS receipt_template_updated_at TIMESTAMPTZ;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_receipt_logo_metadata_check,
  DROP CONSTRAINT IF EXISTS products_receipt_instruction_length_check;

ALTER TABLE public.products
  ADD CONSTRAINT products_receipt_logo_metadata_check CHECK (
    (receipt_logo_file_id IS NULL
      AND receipt_logo_mime_type IS NULL
      AND receipt_logo_original_name IS NULL
      AND receipt_logo_bytes IS NULL
      AND receipt_logo_width IS NULL
      AND receipt_logo_height IS NULL)
    OR
    (BTRIM(receipt_logo_file_id) <> ''
      AND receipt_logo_mime_type IN ('image/png', 'image/jpeg', 'image/webp')
      AND BTRIM(receipt_logo_original_name) <> ''
      AND receipt_logo_bytes BETWEEN 8 AND 8388608
      AND receipt_logo_width BETWEEN 1 AND 12000
      AND receipt_logo_height BETWEEN 1 AND 12000)
  ),
  ADD CONSTRAINT products_receipt_instruction_length_check CHECK (
    CHAR_LENGTH(verification_receipt_instructions) <= 3000
    AND CHAR_LENGTH(recharge_receipt_instructions) <= 3000
  );

COMMENT ON COLUMN public.products.receipt_logo_file_id IS
  'Private pg:// object reference. Original bytes are retained without recompression.';
COMMENT ON COLUMN public.products.verification_receipt_instructions IS
  'Shared by NORMAL and EXPERIENCE verification receipts.';
COMMENT ON COLUMN public.products.recharge_receipt_instructions IS
  'Shared by NEW recharge and REFUND receipts.';

COMMIT;

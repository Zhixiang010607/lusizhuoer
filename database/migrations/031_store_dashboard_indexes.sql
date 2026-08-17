-- Supporting indexes for the store dashboard introduced by faceRecognition v31.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_verification_store_teacher_product_approved
  ON public.verification_records (store_id, teacher_id, product_id)
  INCLUDE (unit_count)
  WHERE record_status = 'APPROVED';

ANALYZE public.verification_records;
COMMIT;

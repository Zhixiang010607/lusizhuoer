-- Cover the headquarters dashboard's date-bounded APPROVED aggregations.
-- Run during a maintenance window because ordinary CREATE INDEX may wait for writers.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_recharge_hq_dashboard_approved_cover
  ON public.recharge_records (submitted_at DESC)
  INCLUDE (store_id, product_id, unit_count, recharge_type)
  WHERE record_status = 'APPROVED';

CREATE INDEX IF NOT EXISTS idx_verification_hq_dashboard_approved_cover
  ON public.verification_records (submitted_at DESC)
  INCLUDE (store_id, product_id, teacher_id, unit_count, verification_type)
  WHERE record_status = 'APPROVED';

ANALYZE public.recharge_records;
ANALYZE public.verification_records;

COMMIT;

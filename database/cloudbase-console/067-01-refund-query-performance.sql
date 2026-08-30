BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

CREATE INDEX IF NOT EXISTS idx_recharge_store_type_cursor
  ON public.recharge_records
  (store_id, recharge_type, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');

CREATE INDEX IF NOT EXISTS idx_recharge_store_type_status_cursor
  ON public.recharge_records
  (store_id, recharge_type, record_status, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');

CREATE INDEX IF NOT EXISTS idx_recharge_type_cursor
  ON public.recharge_records
  (recharge_type, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');

CREATE INDEX IF NOT EXISTS idx_recharge_type_product_store_cursor
  ON public.recharge_records
  (product_id, store_id, recharge_type, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');

ANALYZE public.recharge_records;

COMMIT;

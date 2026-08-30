BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

-- 退费与充值共用 recharge_records。查询应先依靠业务类型、门店、状态和
-- 提交时间完成筛选/分页，再关联客户、门店、项目和老师的展示资料。
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

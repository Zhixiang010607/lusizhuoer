-- 充值记录补齐老师关联字段。
-- 字段允许为空：由业务配置决定老师是否必填；但所有记录表都保留该关联位置。

ALTER TABLE public.recharge_records
  ADD COLUMN IF NOT EXISTS teacher_id BIGINT REFERENCES public.teachers(id);

CREATE INDEX IF NOT EXISTS idx_recharge_teacher_time
  ON public.recharge_records (teacher_id, created_at DESC);

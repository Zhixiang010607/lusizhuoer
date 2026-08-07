-- Add the teacher relationship column to recharge records.
-- The column may be nullable by business configuration, but every record table retains the relationship for traceability.

ALTER TABLE public.recharge_records
  ADD COLUMN IF NOT EXISTS teacher_id BIGINT REFERENCES public.teachers(id);

CREATE INDEX IF NOT EXISTS idx_recharge_teacher_time
  ON public.recharge_records (teacher_id, created_at DESC);

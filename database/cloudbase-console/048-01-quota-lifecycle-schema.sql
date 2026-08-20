-- CloudBase migration 048, part 1 / 7. Run this file by itself.
BEGIN;
DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGCLASS('public.teachers') IS NULL
     OR TO_REGCLASS('public.products') IS NULL
     OR TO_REGCLASS('public.teacher_product_experience_quotas') IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_recharges') IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_resets') IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_usages') IS NULL
     OR TO_REGPROCEDURE('public.teacher_experience_quota_month(timestamptz)') IS NULL
     OR TO_REGPROCEDURE('public.upsert_teacher_product_experience_quota(bigint,bigint,integer,bigint)') IS NULL
     OR TO_REGPROCEDURE('public.recharge_teacher_product_experience_quota(bigint,bigint,integer,text,character varying,bigint)') IS NULL
     OR TO_REGPROCEDURE('public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)') IS NULL THEN
    RAISE EXCEPTION 'teacher face and experience quota prerequisites are missing; execute migrations through 047 first';
  END IF;
END;
$$;

LOCK TABLE public.staff_accounts,
           public.teachers,
           public.products,
           public.teacher_product_experience_quotas,
           public.teacher_experience_quota_recharges,
           public.teacher_experience_quota_resets,
           public.teacher_experience_quota_usages
  IN SHARE ROW EXCLUSIVE MODE;

-- A quota is removed from live configuration by archiving this row, not by
-- deleting it. Recharge/reset/usage rows retain their foreign key and a later
-- configuration reactivates the same audit lineage.
ALTER TABLE public.teacher_product_experience_quotas
  ADD COLUMN IF NOT EXISTS quota_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by_account_id BIGINT REFERENCES public.staff_accounts(id);

ALTER TABLE public.teacher_product_experience_quotas
  DROP CONSTRAINT IF EXISTS teacher_product_experience_quota_status_check;
ALTER TABLE public.teacher_product_experience_quotas
  ADD CONSTRAINT teacher_product_experience_quota_status_check
  CHECK (quota_status IN ('ACTIVE', 'ARCHIVED'));

CREATE INDEX IF NOT EXISTS idx_teacher_product_experience_quotas_active
  ON public.teacher_product_experience_quotas (teacher_id, product_id)
  WHERE quota_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_teacher_experience_quota_usages_teacher_product
  ON public.teacher_experience_quota_usages (teacher_id, product_id, consumed_at DESC);

CREATE TABLE IF NOT EXISTS public.teacher_experience_quota_configuration_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quota_id BIGINT NOT NULL REFERENCES public.teacher_product_experience_quotas(id) ON DELETE RESTRICT,
  teacher_id BIGINT NOT NULL REFERENCES public.teachers(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  event_type VARCHAR(24) NOT NULL CHECK (event_type IN ('CONFIGURED', 'REMOVED')),
  monthly_allowance INTEGER NOT NULL CHECK (monthly_allowance BETWEEN 0 AND 1000000),
  quota_month DATE NOT NULL,
  available_before_count INTEGER NOT NULL CHECK (available_before_count >= 0),
  available_after_count INTEGER NOT NULL CHECK (available_after_count >= 0),
  occurred_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_teacher_experience_quota_configuration_events_quota_time
  ON public.teacher_experience_quota_configuration_events (quota_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_teacher_experience_quota_configuration_events_teacher_product
  ON public.teacher_experience_quota_configuration_events (teacher_id, product_id, occurred_at DESC, id DESC);

ALTER TABLE public.teacher_experience_quota_configuration_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.teacher_experience_quota_configuration_events FROM PUBLIC;

-- Existing configurations predate the immutable configuration-event ledger.
-- Seed exactly one baseline event per historical quota without modifying any
-- existing allowance, remaining count, recharge, reset, or usage record.
INSERT INTO public.teacher_experience_quota_configuration_events
  (quota_id, teacher_id, product_id, event_type, monthly_allowance, quota_month,
   available_before_count, available_after_count, occurred_by_account_id, occurred_at)
SELECT q.id, q.teacher_id, q.product_id, 'CONFIGURED', q.monthly_allowance,
       q.quota_month, 0, q.available_count, q.created_by_account_id, q.created_at
  FROM public.teacher_product_experience_quotas q
 WHERE NOT EXISTS (
   SELECT 1
     FROM public.teacher_experience_quota_configuration_events event
    WHERE event.quota_id = q.id
 );

COMMIT;

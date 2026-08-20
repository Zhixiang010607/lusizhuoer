-- CloudBase migration 046, part 3 / 8. Run this file by itself.
BEGIN;
CREATE TABLE IF NOT EXISTS public.teacher_product_experience_quotas (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  teacher_id BIGINT NOT NULL REFERENCES public.teachers(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  -- monthly_quota_count: the configured monthly base allowance.
  monthly_allowance INTEGER NOT NULL CHECK (monthly_allowance BETWEEN 0 AND 1000000),
  quota_month DATE NOT NULL,
  -- remaining_count: mutable current-month allowance after top-ups/usage.
  available_count INTEGER NOT NULL CHECK (available_count >= 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  manual_recharge_count INTEGER NOT NULL DEFAULT 0 CHECK (manual_recharge_count >= 0),
  monthly_reset_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  created_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  updated_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_teacher_product_experience_quota UNIQUE (teacher_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_product_experience_quotas_teacher
  ON public.teacher_product_experience_quotas (teacher_id, quota_month, product_id);
CREATE INDEX IF NOT EXISTS idx_teacher_product_experience_quotas_product
  ON public.teacher_product_experience_quotas (product_id, teacher_id);

CREATE TABLE IF NOT EXISTS public.teacher_experience_quota_recharges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quota_id BIGINT NOT NULL REFERENCES public.teacher_product_experience_quotas(id) ON DELETE RESTRICT,
  teacher_id BIGINT NOT NULL REFERENCES public.teachers(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quota_month DATE NOT NULL,
  unit_count INTEGER NOT NULL CHECK (unit_count BETWEEN 1 AND 1000000),
  available_before_count INTEGER NOT NULL CHECK (available_before_count >= 0),
  available_after_count INTEGER NOT NULL CHECK (available_after_count >= available_before_count),
  note TEXT NOT NULL DEFAULT '' CHECK (CHAR_LENGTH(note) <= 500),
  idempotency_key VARCHAR(64) NOT NULL CHECK (BTRIM(idempotency_key) <> ''),
  recharged_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_teacher_experience_quota_recharge_idempotency UNIQUE (idempotency_key),
  CONSTRAINT teacher_experience_quota_recharge_math_check
    CHECK (available_after_count = available_before_count + unit_count)
);

CREATE INDEX IF NOT EXISTS idx_teacher_experience_quota_recharges_quota_time
  ON public.teacher_experience_quota_recharges (quota_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.teacher_experience_quota_resets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quota_id BIGINT NOT NULL REFERENCES public.teacher_product_experience_quotas(id) ON DELETE RESTRICT,
  previous_quota_month DATE NOT NULL,
  quota_month DATE NOT NULL,
  available_before_count INTEGER NOT NULL CHECK (available_before_count >= 0),
  monthly_allowance INTEGER NOT NULL CHECK (monthly_allowance >= 0),
  reset_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  reset_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  CONSTRAINT uq_teacher_experience_quota_reset_month UNIQUE (quota_id, quota_month),
  CONSTRAINT teacher_experience_quota_reset_month_check CHECK (quota_month > previous_quota_month)
);

CREATE INDEX IF NOT EXISTS idx_teacher_experience_quota_resets_quota_time
  ON public.teacher_experience_quota_resets (quota_id, quota_month DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.teacher_experience_quota_usages (
  verification_id BIGINT PRIMARY KEY REFERENCES public.verification_records(id) ON DELETE RESTRICT,
  quota_id BIGINT NOT NULL REFERENCES public.teacher_product_experience_quotas(id) ON DELETE RESTRICT,
  teacher_id BIGINT NOT NULL REFERENCES public.teachers(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quota_month DATE NOT NULL,
  unit_count INTEGER NOT NULL DEFAULT 1 CHECK (unit_count = 1),
  available_before_count INTEGER NOT NULL CHECK (available_before_count >= 1),
  available_after_count INTEGER NOT NULL CHECK (available_after_count >= 0),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT teacher_experience_quota_usage_math_check
    CHECK (available_after_count = available_before_count - unit_count)
);

CREATE INDEX IF NOT EXISTS idx_teacher_experience_quota_usages_quota_time
  ON public.teacher_experience_quota_usages (quota_id, consumed_at DESC, verification_id DESC);

ALTER TABLE public.teacher_product_experience_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_experience_quota_recharges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_experience_quota_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_experience_quota_usages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.teacher_product_experience_quotas FROM PUBLIC;
REVOKE ALL ON TABLE public.teacher_experience_quota_recharges FROM PUBLIC;
REVOKE ALL ON TABLE public.teacher_experience_quota_resets FROM PUBLIC;
REVOKE ALL ON TABLE public.teacher_experience_quota_usages FROM PUBLIC;

COMMIT;

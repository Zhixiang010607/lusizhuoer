-- Teacher face enrollment and per-product experience quotas.
--
-- This migration deliberately keeps customer purchased-unit balances separate
-- from teacher experience quotas.  It also keeps historical orders readable:
-- ACTIVE checks are applied only when a new order/configuration is written.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGCLASS('public.teachers') IS NULL
     OR TO_REGCLASS('public.stores') IS NULL
     OR TO_REGCLASS('public.products') IS NULL
     OR TO_REGCLASS('public.customers') IS NULL
     OR TO_REGCLASS('public.recharge_records') IS NULL
     OR TO_REGCLASS('public.verification_records') IS NULL THEN
    RAISE EXCEPTION 'core master-data and order tables must exist before migration 046';
  END IF;
  IF TO_REGCLASS('public.verification_photo_drafts') IS NULL
     OR TO_REGCLASS('public.verification_photos') IS NULL
     OR TO_REGCLASS('public.device_signal_outbox') IS NULL THEN
    RAISE EXCEPTION 'migrations 037, 038 and 041 must be executed before migration 046';
  END IF;
END;
$$;

LOCK TABLE public.staff_accounts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.teachers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.stores IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;

-- Some older incremental installations still carry no-longer-collected
-- identity-card fields from schema.sql.  The teacher creation UI has never
-- collected those values, so do not manufacture fake credentials merely to
-- create a face-bound teacher.  Existing encrypted values are preserved.
DO $$
DECLARE
  column_row RECORD;
BEGIN
  FOR column_row IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teachers'
       AND column_name IN ('id_card_ciphertext', 'id_card_hash', 'phone')
       AND is_nullable = 'NO'
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.teachers ALTER COLUMN %I DROP NOT NULL', column_row.column_name);
  END LOOP;
END;
$$;

-- The historical incremental schema did not give teacher_code a default.
-- The profile trigger below always supplies a code, but adding a deterministic
-- fallback prevents direct, approved administrative imports from failing.
CREATE SEQUENCE IF NOT EXISTS public.teacher_profile_code_seq;
DO $$
DECLARE
  has_default BOOLEAN;
BEGIN
  SELECT COALESCE(column_default IS NOT NULL AND BTRIM(column_default) <> '', FALSE)
    INTO has_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'teachers'
     AND column_name = 'teacher_code';
  IF NOT has_default THEN
    ALTER TABLE public.teachers
      ALTER COLUMN teacher_code SET DEFAULT
        ('TCHF' || LPAD(nextval('public.teacher_profile_code_seq')::TEXT, 12, '0'));
  END IF;
END;
$$;

ALTER TABLE public.teachers
  ADD COLUMN IF NOT EXISTS face_person_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS face_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS face_enrollment_status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS face_enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS face_enrolled_by_account_id BIGINT REFERENCES public.staff_accounts(id);

ALTER TABLE public.teachers
  DROP CONSTRAINT IF EXISTS teachers_face_enrollment_status_check,
  DROP CONSTRAINT IF EXISTS teachers_face_enrollment_shape_check;
ALTER TABLE public.teachers
  ADD CONSTRAINT teachers_face_enrollment_status_check CHECK (
    face_enrollment_status IN ('PENDING', 'ENROLLED', 'LEGACY_UNVERIFIED')
  ),
  ADD CONSTRAINT teachers_face_enrollment_shape_check CHECK (
    (face_enrollment_status = 'ENROLLED'
      AND BTRIM(COALESCE(face_person_id, '')) <> ''
      AND face_consent_at IS NOT NULL
      AND face_enrolled_at IS NOT NULL)
    OR
    (face_enrollment_status IN ('PENDING', 'LEGACY_UNVERIFIED')
      AND face_person_id IS NULL
      AND face_consent_at IS NULL
      AND face_enrolled_at IS NULL
      AND face_enrolled_by_account_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_teachers_face_person_id
  ON public.teachers (face_person_id)
  WHERE face_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teachers_face_enrollment_active
  ON public.teachers (face_enrollment_status, teacher_status, id);

-- Existing records remain readable, but are explicitly marked so that an
-- administrator can enroll a face before selecting or reactivating them.
UPDATE public.teachers
   SET face_enrollment_status = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN 'ENROLLED'
         ELSE 'LEGACY_UNVERIFIED'
       END,
       face_person_id = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN face_person_id
         ELSE NULL
       END,
       face_consent_at = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN face_consent_at
         ELSE NULL
       END,
       face_enrolled_at = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN face_enrolled_at
         ELSE NULL
       END,
       face_enrolled_by_account_id = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN face_enrolled_by_account_id
         ELSE NULL
       END
 WHERE face_enrollment_status = 'PENDING';

-- Ensure every teacher login account owns one actual teacher master row on
-- both rebuilt and incremental databases.  This is intentionally compatible
-- with the old identity-link triggers and preserves existing teacher IDs.
CREATE OR REPLACE FUNCTION public.sync_teacher_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  desired_status TEXT;
BEGIN
  IF NEW.role_code <> 'teacher' THEN
    RETURN NEW;
  END IF;

  desired_status := CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;

  INSERT INTO public.teachers
    (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
  VALUES
    ('TCHF' || NEW.id::TEXT, NEW.staff_name, NEW.id, desired_status, 'PENDING')
  ON CONFLICT (staff_account_id) DO UPDATE
    SET teacher_name = EXCLUDED.teacher_name,
        teacher_status = CASE
          WHEN public.teachers.face_enrollment_status = 'ENROLLED'
            THEN EXCLUDED.teacher_status
          ELSE 'ARCHIVED'
        END,
        updated_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_teacher_profile ON public.staff_accounts;
CREATE TRIGGER trg_sync_teacher_profile
AFTER INSERT OR UPDATE OF staff_name, account_status, role_code ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_profile();

-- A teacher may be active only after the explicit face-enrollment transaction
-- has completed.  Status changes in either direction keep the login account
-- and identity link in sync without deleting historical business records.
CREATE OR REPLACE FUNCTION public.sync_teacher_account_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  desired_status TEXT;
BEGIN
  IF NEW.staff_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  desired_status := CASE
    WHEN NEW.teacher_status = 'ACTIVE'
      AND NEW.face_enrollment_status = 'ENROLLED'
      AND BTRIM(COALESCE(NEW.face_person_id, '')) <> ''
      THEN 'ACTIVE'
    ELSE 'ARCHIVED'
  END;
  UPDATE public.staff_accounts
     SET account_status = desired_status,
         updated_at = NOW()
   WHERE id = NEW.staff_account_id
     AND account_status IS DISTINCT FROM desired_status;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_teacher_account_status ON public.teachers;
CREATE TRIGGER trg_sync_teacher_account_status
AFTER INSERT OR UPDATE OF teacher_status, staff_account_id, face_enrollment_status, face_person_id
ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_account_status();

-- Backfill the missing teacher profiles before the quota foreign keys and
-- face-enrollment actions use them.  Accounts remain archived until a face is
-- enrolled, preventing a profile-created but incomplete teacher from logging
-- in or appearing in business selection lists.
INSERT INTO public.teachers
  (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
SELECT 'TCHF' || account.id::TEXT, account.staff_name, account.id, 'ARCHIVED', 'PENDING'
  FROM public.staff_accounts AS account
 WHERE account.role_code = 'teacher'
   AND NOT EXISTS (
     SELECT 1 FROM public.teachers AS teacher
      WHERE teacher.staff_account_id = account.id
   );

UPDATE public.teachers
   SET teacher_status = 'ARCHIVED'
 WHERE teacher_status = 'ACTIVE'
   AND face_enrollment_status <> 'ENROLLED';

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

CREATE OR REPLACE FUNCTION public.teacher_experience_quota_month(p_at TIMESTAMPTZ DEFAULT CLOCK_TIMESTAMP())
RETURNS DATE
LANGUAGE sql
STABLE
AS $$
  SELECT DATE_TRUNC('month', p_at AT TIME ZONE 'Asia/Shanghai')::DATE;
$$;

CREATE OR REPLACE FUNCTION public.assert_teacher_experience_quota_actor(p_actor_account_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.staff_accounts
     WHERE id = p_actor_account_id
       AND role_code = 'hq'
       AND account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'only an active headquarters account can manage teacher experience quotas'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_active_teacher_experience_subjects(
  p_teacher_id BIGINT,
  p_product_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.teachers AS teacher
      JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
     WHERE teacher.id = p_teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND teacher.face_enrollment_status = 'ENROLLED'
       AND BTRIM(COALESCE(teacher.face_person_id, '')) <> ''
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'teacher is missing, archived, or has not completed face enrollment'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = p_product_id
       AND product_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'product is missing or archived'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_teacher_experience_quota(
  p_quota_id BIGINT,
  p_effective_month DATE DEFAULT public.teacher_experience_quota_month(),
  p_reset_by_account_id BIGINT DEFAULT NULL
)
RETURNS public.teacher_product_experience_quotas
LANGUAGE plpgsql
AS $$
DECLARE
  quota public.teacher_product_experience_quotas%ROWTYPE;
  prior_month DATE;
  prior_available INTEGER;
BEGIN
  IF p_effective_month <> DATE_TRUNC('month', p_effective_month)::DATE THEN
    RAISE EXCEPTION 'effective quota month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO quota
    FROM public.teacher_product_experience_quotas
   WHERE id = p_quota_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher experience quota does not exist'
      USING ERRCODE = 'P0002';
  END IF;

  IF quota.quota_month < p_effective_month THEN
    prior_month := quota.quota_month;
    prior_available := quota.available_count;
    UPDATE public.teacher_product_experience_quotas
       SET quota_month = p_effective_month,
           available_count = monthly_allowance,
           used_count = 0,
           manual_recharge_count = 0,
           monthly_reset_at = CLOCK_TIMESTAMP(),
           updated_at = CLOCK_TIMESTAMP()
     WHERE id = quota.id
     RETURNING * INTO quota;
    INSERT INTO public.teacher_experience_quota_resets
      (quota_id, previous_quota_month, quota_month, available_before_count,
       monthly_allowance, reset_by_account_id)
    VALUES
      (quota.id, prior_month, p_effective_month, prior_available,
       quota.monthly_allowance, p_reset_by_account_id)
    ON CONFLICT (quota_id, quota_month) DO NOTHING;
  END IF;

  RETURN quota;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_teacher_experience_quotas(
  p_effective_month DATE DEFAULT public.teacher_experience_quota_month(),
  p_reset_by_account_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  quota_row RECORD;
  reset_count INTEGER := 0;
BEGIN
  IF p_effective_month <> DATE_TRUNC('month', p_effective_month)::DATE THEN
    RAISE EXCEPTION 'effective quota month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  FOR quota_row IN
    SELECT id
      FROM public.teacher_product_experience_quotas
     WHERE quota_month < p_effective_month
     ORDER BY id
     FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public.reset_teacher_experience_quota(
      quota_row.id, p_effective_month, p_reset_by_account_id
    );
    reset_count := reset_count + 1;
  END LOOP;
  RETURN reset_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_teacher_product_experience_quota(
  p_teacher_id BIGINT,
  p_product_id BIGINT,
  p_monthly_allowance INTEGER,
  p_actor_account_id BIGINT
)
RETURNS TABLE(
  id BIGINT,
  teacher_id BIGINT,
  product_id BIGINT,
  monthly_allowance INTEGER,
  quota_month DATE,
  available_count INTEGER,
  used_count INTEGER,
  manual_recharge_count INTEGER,
  monthly_reset_at TIMESTAMPTZ,
  created_now BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  quota public.teacher_product_experience_quotas%ROWTYPE;
  effective_month DATE := public.teacher_experience_quota_month();
  inserted_now BOOLEAN := FALSE;
BEGIN
  IF p_monthly_allowance IS NULL OR p_monthly_allowance < 0 OR p_monthly_allowance > 1000000 THEN
    RAISE EXCEPTION 'monthly allowance must be an integer from 0 to 1000000'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM public.assert_active_teacher_experience_subjects(p_teacher_id, p_product_id);

  INSERT INTO public.teacher_product_experience_quotas
    (teacher_id, product_id, monthly_allowance, quota_month, available_count,
     used_count, manual_recharge_count, created_by_account_id, updated_by_account_id)
  VALUES
    (p_teacher_id, p_product_id, p_monthly_allowance, effective_month,
     p_monthly_allowance, 0, 0, p_actor_account_id, p_actor_account_id)
  ON CONFLICT (teacher_id, product_id) DO NOTHING
  RETURNING * INTO quota;

  IF FOUND THEN
    inserted_now := TRUE;
  ELSE
    SELECT * INTO quota
      FROM public.teacher_product_experience_quotas
     WHERE teacher_id = p_teacher_id AND product_id = p_product_id
     FOR UPDATE;
    quota := public.reset_teacher_experience_quota(quota.id, effective_month, p_actor_account_id);
    UPDATE public.teacher_product_experience_quotas
       SET monthly_allowance = p_monthly_allowance,
           updated_by_account_id = p_actor_account_id,
           updated_at = CLOCK_TIMESTAMP()
     WHERE id = quota.id
     RETURNING * INTO quota;
  END IF;

  RETURN QUERY SELECT quota.id, quota.teacher_id, quota.product_id,
    quota.monthly_allowance, quota.quota_month, quota.available_count,
    quota.used_count, quota.manual_recharge_count, quota.monthly_reset_at,
    inserted_now;
END;
$$;

CREATE OR REPLACE FUNCTION public.recharge_teacher_product_experience_quota(
  p_teacher_id BIGINT,
  p_product_id BIGINT,
  p_unit_count INTEGER,
  p_note TEXT,
  p_idempotency_key VARCHAR,
  p_actor_account_id BIGINT
)
RETURNS TABLE(
  recharge_id BIGINT,
  created_now BOOLEAN,
  quota_id BIGINT,
  quota_month DATE,
  available_before_count INTEGER,
  available_after_count INTEGER,
  monthly_allowance INTEGER,
  used_count INTEGER,
  manual_recharge_count INTEGER,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  quota public.teacher_product_experience_quotas%ROWTYPE;
  existing public.teacher_experience_quota_recharges%ROWTYPE;
  effective_month DATE := public.teacher_experience_quota_month();
  normalized_note TEXT := BTRIM(COALESCE(p_note, ''));
  before_count INTEGER;
BEGIN
  IF p_unit_count IS NULL OR p_unit_count < 1 OR p_unit_count > 1000000 THEN
    RAISE EXCEPTION 'recharge unit count must be an integer from 1 to 1000000'
      USING ERRCODE = '22023';
  END IF;
  IF CHAR_LENGTH(normalized_note) > 500 THEN
    RAISE EXCEPTION 'recharge note is too long' USING ERRCODE = '22001';
  END IF;
  IF BTRIM(COALESCE(p_idempotency_key, '')) !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$' THEN
    RAISE EXCEPTION 'valid idempotency key is required' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-recharge:' || p_idempotency_key));

  SELECT * INTO existing
    FROM public.teacher_experience_quota_recharges
   WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.teacher_id <> p_teacher_id
       OR existing.product_id <> p_product_id
       OR existing.unit_count <> p_unit_count
       OR existing.note <> normalized_note
       OR existing.recharged_by_account_id <> p_actor_account_id THEN
      RAISE EXCEPTION 'idempotency key belongs to a different teacher experience recharge'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO quota
      FROM public.teacher_product_experience_quotas
     WHERE id = existing.quota_id;
    RETURN QUERY SELECT existing.id, FALSE, existing.quota_id, existing.quota_month,
      existing.available_before_count, existing.available_after_count,
      quota.monthly_allowance, quota.used_count, quota.manual_recharge_count,
      existing.created_at;
    RETURN;
  END IF;

  PERFORM public.assert_active_teacher_experience_subjects(p_teacher_id, p_product_id);
  SELECT * INTO quota
    FROM public.teacher_product_experience_quotas
   WHERE teacher_id = p_teacher_id AND product_id = p_product_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no configured experience quota for this product'
      USING ERRCODE = '23514';
  END IF;
  quota := public.reset_teacher_experience_quota(quota.id, effective_month, p_actor_account_id);
  before_count := quota.available_count;
  UPDATE public.teacher_product_experience_quotas
     SET available_count = available_count + p_unit_count,
         manual_recharge_count = manual_recharge_count + p_unit_count,
         updated_by_account_id = p_actor_account_id,
         updated_at = CLOCK_TIMESTAMP()
   WHERE id = quota.id
   RETURNING * INTO quota;

  INSERT INTO public.teacher_experience_quota_recharges
    (quota_id, teacher_id, product_id, quota_month, unit_count,
     available_before_count, available_after_count, note, idempotency_key,
     recharged_by_account_id)
  VALUES
    (quota.id, p_teacher_id, p_product_id, quota.quota_month, p_unit_count,
     before_count, quota.available_count, normalized_note, p_idempotency_key,
     p_actor_account_id)
  RETURNING * INTO existing;

  RETURN QUERY SELECT existing.id, TRUE, quota.id, quota.quota_month,
    before_count, quota.available_count, quota.monthly_allowance,
    quota.used_count, quota.manual_recharge_count, existing.created_at;
END;
$$;

-- Final order-state authority.  Migration 044 accidentally made EXPERIENCE
-- pending even though migration 041 and the face-photo function create it as
-- immediately approved.  Keep NORMAL and EXPERIENCE both effective directly.
CREATE OR REPLACE FUNCTION public.guard_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'recharge_records' THEN
      IF NEW.recharge_type NOT IN ('NEW', 'REFUND') THEN
        RAISE EXCEPTION 'new recharge orders must be NEW or REFUND' USING ERRCODE = '23514';
      END IF;
      IF NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a recharge or refund application must start as PENDING' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'verification_records' THEN
      IF NEW.verification_type IN ('NORMAL', 'EXPERIENCE') AND NEW.record_status <> 'APPROVED' THEN
        RAISE EXCEPTION 'a NORMAL or EXPERIENCE verification must be effective immediately' USING ERRCODE = '23514';
      END IF;
      IF NEW.verification_type = 'SUPPLEMENT' AND NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a historical SUPPLEMENT verification must start as PENDING' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.record_status IS NOT DISTINCT FROM OLD.record_status THEN RETURN NEW; END IF;
  IF OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED', 'REJECTED') THEN RETURN NEW; END IF;
  IF OLD.record_status = 'APPROVED' AND NEW.record_status = 'VOIDED' AND NEW.void_request_status = 'APPROVED' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid order status transition: % -> %', OLD.record_status, NEW.record_status USING ERRCODE = '23514';
END;
$$;

-- Backend predicates are deliberately repeated at the database boundary. A
-- stale page or direct server-side call cannot select an archived store,
-- teacher, product or customer for a new recharge/refund/verification.
CREATE OR REPLACE FUNCTION public.assert_active_order_master_data()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stores
     WHERE id = NEW.store_id AND store_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing store cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers
     WHERE id = NEW.customer_id
       AND created_store_id = NEW.store_id
       AND customer_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived, missing, or foreign-store customer cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = NEW.product_id AND product_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing product cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NEW.teacher_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.teachers AS teacher
      JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
     WHERE teacher.id = NEW.teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND teacher.face_enrollment_status = 'ENROLLED'
       AND BTRIM(COALESCE(teacher.face_person_id, '')) <> ''
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived, unbound-face, or missing teacher cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_accounts
     WHERE id = NEW.submitted_by_account_id
       AND account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived submitting account cannot create a new order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recharge_active_master_data ON public.recharge_records;
CREATE TRIGGER trg_recharge_active_master_data
BEFORE INSERT ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.assert_active_order_master_data();

DROP TRIGGER IF EXISTS trg_verification_active_master_data ON public.verification_records;
CREATE TRIGGER trg_verification_active_master_data
BEFORE INSERT ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.assert_active_order_master_data();

-- Keep the verification function small enough for the CloudBase SQL editor
-- while retaining all master-data locks inside the same outer transaction.
CREATE OR REPLACE FUNCTION public.lock_active_verification_subjects(
  p_store_id BIGINT,
  p_teacher_id BIGINT,
  p_customer_id BIGINT,
  p_product_id BIGINT,
  p_submitted_by_account_id BIGINT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE profile_object_ref TEXT;
BEGIN
  PERFORM 1 FROM public.stores WHERE id = p_store_id AND store_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store is missing or archived' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.customers
   WHERE id = p_customer_id AND created_store_id = p_store_id AND customer_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer is missing, archived, or belongs to another store' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.products WHERE id = p_product_id AND product_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product is missing or archived' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.teachers teacher
   WHERE teacher.id = p_teacher_id AND teacher.teacher_status = 'ACTIVE'
     AND teacher.face_enrollment_status = 'ENROLLED'
     AND BTRIM(COALESCE(teacher.face_person_id, '')) <> ''
     AND EXISTS (SELECT 1 FROM public.staff_accounts account
                  WHERE account.id = teacher.staff_account_id
                    AND account.role_code = 'teacher' AND account.account_status = 'ACTIVE') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'teacher is missing, archived, or has not completed face enrollment' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.staff_accounts
   WHERE id = p_submitted_by_account_id AND account_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'submitting account is missing or archived' USING ERRCODE = '23514'; END IF;
  SELECT profile_photo_file_id INTO profile_object_ref FROM public.customers WHERE id = p_customer_id FOR SHARE;
  IF BTRIM(COALESCE(profile_object_ref, '')) = '' THEN
    RAISE EXCEPTION 'customer retained profile photo is required' USING ERRCODE = '22023';
  END IF;
  RETURN profile_object_ref;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_matching_verification_idempotency(
  p_verification_id BIGINT, p_verification_type VARCHAR, p_store_id BIGINT,
  p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_supplement_note TEXT,
  p_face_request_id VARCHAR, p_face_evidence_token VARCHAR
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.verification_records v
     WHERE v.id = p_verification_id AND v.verification_type = p_verification_type
       AND v.store_id = p_store_id AND v.teacher_id = p_teacher_id
       AND v.customer_id = p_customer_id AND v.product_id = p_product_id
       AND v.submitted_by_account_id = p_submitted_by_account_id
       AND v.message = COALESCE(p_message, '')
       AND v.supplement_note = COALESCE(p_supplement_note, '')
       AND v.face_request_id = p_face_request_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.verification_photos photo
     WHERE photo.verification_id = p_verification_id AND photo.photo_slot = 0 AND photo.photo_kind = 'PROFILE'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.verification_photos photo
     WHERE photo.verification_id = p_verification_id AND photo.photo_slot = 1
       AND photo.photo_kind = 'FACE' AND photo.source_evidence_token = p_face_evidence_token
  ) THEN
    RAISE EXCEPTION 'idempotency key belongs to a different verification request' USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo(
  p_verification_type VARCHAR,
  p_store_id BIGINT,
  p_teacher_id BIGINT,
  p_customer_id BIGINT,
  p_product_id BIGINT,
  p_record_status VARCHAR,
  p_submitted_by_account_id BIGINT,
  p_message TEXT,
  p_supplement_note TEXT,
  p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR,
  p_idempotency_key VARCHAR
)
RETURNS TABLE(
  id BIGINT,
  verification_code TEXT,
  verification_type TEXT,
  store_id BIGINT,
  teacher_id BIGINT,
  customer_id BIGINT,
  product_id BIGINT,
  unit_count INTEGER,
  record_status TEXT,
  submitted_by_account_id BIGINT,
  submitted_at TIMESTAMPTZ,
  message TEXT,
  supplement_note TEXT,
  face_request_id TEXT,
  idempotency_key TEXT,
  created_now BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  existing_record public.verification_records%ROWTYPE;
  draft public.verification_photo_drafts%ROWTYPE;
  created_record public.verification_records%ROWTYPE;
  quota public.teacher_product_experience_quotas%ROWTYPE;
  usage public.teacher_experience_quota_usages%ROWTYPE;
  profile_object_ref TEXT;
  normalized_type TEXT := UPPER(BTRIM(COALESCE(p_verification_type, '')));
  normalized_status TEXT := UPPER(BTRIM(COALESCE(p_record_status, '')));
  effective_month DATE := public.teacher_experience_quota_month();
  quota_before INTEGER;
BEGIN
  IF normalized_type NOT IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE') THEN
    RAISE EXCEPTION 'unsupported verification type' USING ERRCODE = '22023';
  END IF;
  IF normalized_status <> (CASE WHEN normalized_type = 'SUPPLEMENT' THEN 'PENDING' ELSE 'APPROVED' END) THEN
    RAISE EXCEPTION 'verification status does not match verification type' USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_face_evidence_token, '')) = '' THEN
    RAISE EXCEPTION 'face photo evidence is required' USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_face_request_id, '')) = '' THEN
    RAISE EXCEPTION 'face verification request id is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));
  SELECT v.* INTO existing_record
    FROM public.verification_records AS v
   WHERE v.idempotency_key = p_idempotency_key
   LIMIT 1;
  IF existing_record.id IS NOT NULL THEN
    PERFORM public.assert_matching_verification_idempotency(
      existing_record.id, normalized_type, p_store_id, p_teacher_id, p_customer_id,
      p_product_id, p_submitted_by_account_id, p_message, p_supplement_note,
      p_face_request_id, p_face_evidence_token
    );
    IF existing_record.verification_type = 'EXPERIENCE' AND NOT EXISTS (
      SELECT 1 FROM public.teacher_experience_quota_usages WHERE verification_id = existing_record.id
    ) THEN
      RAISE EXCEPTION 'experience verification is missing its teacher quota usage audit row' USING ERRCODE = '23514';
    END IF;
    IF existing_record.verification_type IN ('NORMAL', 'EXPERIENCE')
       AND existing_record.record_status = 'APPROVED' THEN
      INSERT INTO public.device_signal_outbox
        (verification_id, store_id, customer_id, product_id, teacher_id)
      VALUES
        (existing_record.id, existing_record.store_id, existing_record.customer_id,
         existing_record.product_id, existing_record.teacher_id)
      ON CONFLICT (verification_id) DO NOTHING;
    END IF;
    RETURN QUERY SELECT existing_record.id, existing_record.verification_code::TEXT,
      existing_record.verification_type::TEXT, existing_record.store_id,
      existing_record.teacher_id, existing_record.customer_id,
      existing_record.product_id, existing_record.unit_count,
      existing_record.record_status::TEXT, existing_record.submitted_by_account_id,
      existing_record.submitted_at, existing_record.message,
      existing_record.supplement_note, existing_record.face_request_id::TEXT,
      existing_record.idempotency_key::TEXT, FALSE;
    RETURN;
  END IF;

  profile_object_ref := public.lock_active_verification_subjects(
    p_store_id, p_teacher_id, p_customer_id, p_product_id, p_submitted_by_account_id
  );

  SELECT d.* INTO draft
    FROM public.verification_photo_drafts AS d
   WHERE d.evidence_token = p_face_evidence_token
     AND d.store_id = p_store_id
     AND d.customer_id = p_customer_id
     AND d.submitted_by_account_id = p_submitted_by_account_id
     AND d.face_request_id = p_face_request_id
     AND d.consumed_at IS NULL
     AND d.expires_at > CLOCK_TIMESTAMP()
   FOR UPDATE;
  IF draft.evidence_token IS NULL THEN
    RAISE EXCEPTION 'face photo evidence is missing, expired, consumed, or belongs to another request' USING ERRCODE = '42501';
  END IF;

  IF normalized_type = 'EXPERIENCE' THEN
    SELECT * INTO quota
      FROM public.teacher_product_experience_quotas
     WHERE teacher_id = p_teacher_id AND product_id = p_product_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'teacher has no configured experience quota for this product' USING ERRCODE = '23514';
    END IF;
    quota := public.reset_teacher_experience_quota(quota.id, effective_month, NULL);
    IF quota.available_count < 1 THEN
      RAISE EXCEPTION 'insufficient teacher experience quota for this product' USING ERRCODE = '23514';
    END IF;
    quota_before := quota.available_count;
    UPDATE public.teacher_product_experience_quotas
       SET available_count = available_count - 1,
           used_count = used_count + 1,
           updated_at = CLOCK_TIMESTAMP()
     WHERE id = quota.id
     RETURNING * INTO quota;
  END IF;

  INSERT INTO public.verification_records
    (verification_type, store_id, teacher_id, customer_id, product_id,
     unit_count, record_status, submitted_by_account_id, message,
     supplement_note, face_request_id, idempotency_key)
  VALUES
    (normalized_type, p_store_id, p_teacher_id, p_customer_id, p_product_id,
     1, normalized_status, p_submitted_by_account_id, COALESCE(p_message, ''),
     COALESCE(p_supplement_note, ''), p_face_request_id, p_idempotency_key)
  RETURNING * INTO created_record;

  IF normalized_type = 'EXPERIENCE' THEN
    INSERT INTO public.teacher_experience_quota_usages
      (verification_id, quota_id, teacher_id, product_id, quota_month,
       unit_count, available_before_count, available_after_count)
    VALUES
      (created_record.id, quota.id, p_teacher_id, p_product_id,
       quota.quota_month, 1, quota_before, quota.available_count)
    RETURNING * INTO usage;
  END IF;

  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref,
     thumbnail_object_ref, original_bytes, thumbnail_bytes,
     image_width, image_height, sha256, uploaded_by_account_id,
     source_evidence_token)
  VALUES
    (created_record.id, 0, 'PROFILE', profile_object_ref,
     profile_object_ref, NULL, NULL, NULL, NULL, NULL,
     p_submitted_by_account_id, NULL),
    (created_record.id, 1, 'FACE', draft.original_object_ref,
     draft.thumbnail_object_ref, draft.original_bytes, draft.thumbnail_bytes,
     draft.image_width, draft.image_height, draft.sha256,
     p_submitted_by_account_id, draft.evidence_token);

  INSERT INTO public.verification_photo_events
    (verification_id, photo_slot, event_type, actor_account_id)
  VALUES
    (created_record.id, 0, 'PROFILE_BOUND', p_submitted_by_account_id),
    (created_record.id, 1, 'FACE_BOUND', p_submitted_by_account_id);

  UPDATE public.verification_photo_drafts
     SET consumed_by_verification_id = created_record.id,
         consumed_at = NOW()
   WHERE evidence_token = draft.evidence_token;

  IF created_record.verification_type IN ('NORMAL', 'EXPERIENCE')
     AND created_record.record_status = 'APPROVED' THEN
    INSERT INTO public.device_signal_outbox
      (verification_id, store_id, customer_id, product_id, teacher_id)
    VALUES
      (created_record.id, created_record.store_id, created_record.customer_id,
       created_record.product_id, created_record.teacher_id);
  END IF;

  RETURN QUERY SELECT created_record.id, created_record.verification_code::TEXT,
    created_record.verification_type::TEXT, created_record.store_id,
    created_record.teacher_id, created_record.customer_id,
    created_record.product_id, created_record.unit_count,
    created_record.record_status::TEXT, created_record.submitted_by_account_id,
    created_record.submitted_at, created_record.message,
    created_record.supplement_note, created_record.face_request_id::TEXT,
    created_record.idempotency_key::TEXT, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_experience_quota_month(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_teacher_experience_quota_actor(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_teacher_experience_subjects(BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_teacher_experience_quota(BIGINT, DATE, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_teacher_experience_quotas(DATE, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recharge_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, TEXT, VARCHAR, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_order_master_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_active_verification_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_matching_verification_idempotency(
  BIGINT, VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, VARCHAR, VARCHAR
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC;

COMMENT ON TABLE public.teacher_product_experience_quotas IS
  'One configured monthly base allowance for each teacher and product. This is separate from customer purchased-unit balances.';
COMMENT ON TABLE public.teacher_experience_quota_recharges IS
  'Immutable headquarters top-up ledger for a teacher product experience quota.';
COMMENT ON TABLE public.teacher_experience_quota_usages IS
  'Immutable link proving that each new EXPERIENCE verification atomically consumed one teacher quota unit.';
COMMENT ON FUNCTION public.reset_teacher_experience_quotas(DATE, BIGINT) IS
  'Safe monthly reset entry point. Invoke on the first day of each Asia/Shanghai month; reads and consumes also lazily reset.';

COMMIT;

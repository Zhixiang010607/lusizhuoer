-- Optional teacher face enrollment and experience quota lifecycle.
--
-- Migration 046 made a teacher face enrollment a prerequisite for activation
-- and stored one mutable quota row for each teacher/product.  Product policy
-- now permits an ACTIVE teacher without a face, a later face replacement, and
-- removing/reconfiguring a live experience entitlement without losing its
-- recharge, reset, or verification audit history.

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

-- A face is an optional identity profile attribute. Teacher/account ACTIVE
-- state is now mirrored directly; only archive status controls login and
-- master-data selection. The face shape constraint from 046 continues to
-- protect the integrity of an enrolled face when one is supplied.
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
        teacher_status = EXCLUDED.teacher_status,
        updated_at = NOW();
  RETURN NEW;
END;
$$;

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
  desired_status := CASE WHEN NEW.teacher_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;
  UPDATE public.staff_accounts
     SET account_status = desired_status,
         updated_at = NOW()
   WHERE id = NEW.staff_account_id
     AND account_status IS DISTINCT FROM desired_status;
  RETURN NEW;
END;
$$;

-- Active quota configuration, recharge, and monthly reset require a live
-- teacher login/profile and a live product, but never a teacher face.
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
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'teacher is missing or archived'
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

CREATE OR REPLACE FUNCTION public.teacher_experience_quota_is_resettable(
  p_quota_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.teacher_product_experience_quotas quota
      JOIN public.teachers teacher ON teacher.id = quota.teacher_id
      JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
      JOIN public.products product ON product.id = quota.product_id
     WHERE quota.id = p_quota_id
       AND quota.quota_status = 'ACTIVE'
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
       AND product.product_status = 'ACTIVE'
  );
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

  IF quota.quota_status <> 'ACTIVE'
     OR NOT public.teacher_experience_quota_is_resettable(quota.id) THEN
    RETURN quota;
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
    SELECT quota.id
      FROM public.teacher_product_experience_quotas quota
      JOIN public.teachers teacher ON teacher.id = quota.teacher_id
      JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
      JOIN public.products product ON product.id = quota.product_id
     WHERE quota.quota_month < p_effective_month
       AND quota.quota_status = 'ACTIVE'
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
       AND product.product_status = 'ACTIVE'
     ORDER BY quota.id
     FOR UPDATE OF quota SKIP LOCKED
  LOOP
    PERFORM public.reset_teacher_experience_quota(
      quota_row.id, p_effective_month, p_reset_by_account_id
    );
    reset_count := reset_count + 1;
  END LOOP;
  RETURN reset_count;
END;
$$;

-- Every configuration is an immediate replacement of the current balance.
-- It deliberately does not carry forward a prior remaining balance, current
-- month recharge total, or current month usage total. Immutable ledgers keep
-- the full audit trail and all-time experience counts.
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
  previous_available INTEGER := 0;
BEGIN
  IF p_monthly_allowance IS NULL OR p_monthly_allowance < 0 OR p_monthly_allowance > 1000000 THEN
    RAISE EXCEPTION 'monthly allowance must be an integer from 0 to 1000000'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM public.assert_active_teacher_experience_subjects(p_teacher_id, p_product_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));

  INSERT INTO public.teacher_product_experience_quotas
    (teacher_id, product_id, monthly_allowance, quota_month, available_count,
     used_count, manual_recharge_count, quota_status, created_by_account_id,
     updated_by_account_id)
  VALUES
    (p_teacher_id, p_product_id, p_monthly_allowance, effective_month,
     p_monthly_allowance, 0, 0, 'ACTIVE', p_actor_account_id, p_actor_account_id)
  ON CONFLICT (teacher_id, product_id) DO NOTHING
  RETURNING * INTO quota;

  IF FOUND THEN
    inserted_now := TRUE;
  ELSE
    SELECT * INTO quota
      FROM public.teacher_product_experience_quotas
     WHERE teacher_id = p_teacher_id
       AND product_id = p_product_id
     FOR UPDATE;
    previous_available := quota.available_count;
    UPDATE public.teacher_product_experience_quotas
       SET quota_status = 'ACTIVE',
           archived_at = NULL,
           archived_by_account_id = NULL,
           monthly_allowance = p_monthly_allowance,
           quota_month = effective_month,
           available_count = p_monthly_allowance,
           used_count = 0,
           manual_recharge_count = 0,
           monthly_reset_at = CLOCK_TIMESTAMP(),
           updated_by_account_id = p_actor_account_id,
           updated_at = CLOCK_TIMESTAMP()
     WHERE id = quota.id
     RETURNING * INTO quota;
  END IF;

  INSERT INTO public.teacher_experience_quota_configuration_events
    (quota_id, teacher_id, product_id, event_type, monthly_allowance,
     quota_month, available_before_count, available_after_count,
     occurred_by_account_id)
  VALUES
    (quota.id, quota.teacher_id, quota.product_id, 'CONFIGURED',
     quota.monthly_allowance, quota.quota_month, previous_available,
     quota.available_count, p_actor_account_id);

  RETURN QUERY SELECT quota.id, quota.teacher_id, quota.product_id,
    quota.monthly_allowance, quota.quota_month, quota.available_count,
    quota.used_count, quota.manual_recharge_count, quota.monthly_reset_at,
    inserted_now;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_teacher_product_experience_quota(
  p_teacher_id BIGINT,
  p_product_id BIGINT,
  p_actor_account_id BIGINT
)
RETURNS TABLE(
  quota_id BIGINT,
  teacher_id BIGINT,
  product_id BIGINT,
  available_count INTEGER,
  removed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  quota public.teacher_product_experience_quotas%ROWTYPE;
  removed_at_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));
  SELECT * INTO quota
    FROM public.teacher_product_experience_quotas
   WHERE teacher_id = p_teacher_id
     AND product_id = p_product_id
     AND quota_status = 'ACTIVE'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no active experience quota for this product'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.teacher_product_experience_quotas
     SET quota_status = 'ARCHIVED',
         archived_at = removed_at_value,
         archived_by_account_id = p_actor_account_id,
         updated_by_account_id = p_actor_account_id,
         updated_at = removed_at_value
   WHERE id = quota.id
   RETURNING * INTO quota;

  INSERT INTO public.teacher_experience_quota_configuration_events
    (quota_id, teacher_id, product_id, event_type, monthly_allowance,
     quota_month, available_before_count, available_after_count,
     occurred_by_account_id, occurred_at)
  VALUES
    (quota.id, quota.teacher_id, quota.product_id, 'REMOVED',
     quota.monthly_allowance, quota.quota_month, quota.available_count,
     quota.available_count, p_actor_account_id, removed_at_value);

  RETURN QUERY SELECT quota.id, quota.teacher_id, quota.product_id,
    quota.available_count, removed_at_value;
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
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));

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
   WHERE teacher_id = p_teacher_id
     AND product_id = p_product_id
     AND quota_status = 'ACTIVE'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no active configured experience quota for this product'
      USING ERRCODE = '23514';
  END IF;
  quota := public.reset_teacher_experience_quota(quota.id, effective_month, p_actor_account_id);
  IF quota.quota_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'teacher has no active configured experience quota for this product'
      USING ERRCODE = '23514';
  END IF;
  before_count := quota.available_count;
  UPDATE public.teacher_product_experience_quotas
     SET available_count = available_count + p_unit_count,
         manual_recharge_count = manual_recharge_count + p_unit_count,
         updated_by_account_id = p_actor_account_id,
         updated_at = CLOCK_TIMESTAMP()
   WHERE id = quota.id
     AND quota_status = 'ACTIVE'
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

-- These order-level predicates are the final authorization boundary for new
-- business records. Teacher face enrollment is deliberately absent: the
-- customer face capture in a verification remains mandatory and independent.
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
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing teacher cannot receive a new order' USING ERRCODE = '23514';
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
     AND EXISTS (SELECT 1 FROM public.staff_accounts account
                  WHERE account.id = teacher.staff_account_id
                    AND account.role_code = 'teacher' AND account.account_status = 'ACTIVE') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'teacher is missing or archived' USING ERRCODE = '23514'; END IF;
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

-- create_verification_with_face_photo locks and decrements its quota before
-- it writes the immutable usage row. This guard makes a removed configuration
-- fail the whole transaction, so a stale direct call cannot consume it.
CREATE OR REPLACE FUNCTION public.assert_active_teacher_experience_quota_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.teacher_product_experience_quotas quota
      JOIN public.teachers teacher ON teacher.id = quota.teacher_id
      JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
      JOIN public.products product ON product.id = quota.product_id
     WHERE quota.id = NEW.quota_id
       AND quota.teacher_id = NEW.teacher_id
       AND quota.product_id = NEW.product_id
       AND quota.quota_status = 'ACTIVE'
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
       AND product.product_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'teacher has no active configured experience quota for this product'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_active_teacher_experience_quota_usage
  ON public.teacher_experience_quota_usages;
CREATE TRIGGER trg_assert_active_teacher_experience_quota_usage
BEFORE INSERT ON public.teacher_experience_quota_usages
FOR EACH ROW EXECUTE FUNCTION public.assert_active_teacher_experience_quota_usage();

REVOKE ALL ON FUNCTION public.sync_teacher_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_teacher_account_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_teacher_experience_subjects(BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_experience_quota_is_resettable(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_teacher_experience_quota(BIGINT, DATE, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_teacher_experience_quotas(DATE, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_teacher_product_experience_quota(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recharge_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, TEXT, VARCHAR, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_order_master_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_active_verification_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_teacher_experience_quota_usage() FROM PUBLIC;

COMMENT ON TABLE public.teacher_experience_quota_configuration_events IS
  'Immutable configuration/removal history. Removing a live teacher product entitlement archives the quota instead of deleting its audit lineage.';
COMMENT ON FUNCTION public.upsert_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, BIGINT) IS
  'Migration 048: every configuration immediately replaces the current available count with the selected monthly allowance.';
COMMENT ON FUNCTION public.reset_teacher_experience_quotas(DATE, BIGINT) IS
  'Migration 048: monthly reset affects only ACTIVE teacher accounts, ACTIVE teacher profiles, ACTIVE quota configurations, and ACTIVE products.';

COMMIT;

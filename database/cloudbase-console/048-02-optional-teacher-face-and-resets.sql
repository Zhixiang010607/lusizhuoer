-- CloudBase migration 048, part 2 / 7. Run this file by itself.
BEGIN;
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

COMMIT;

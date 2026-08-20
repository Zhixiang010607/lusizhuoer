-- CloudBase migration 046, part 4 / 8. Run this file by itself.
BEGIN;
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

COMMIT;

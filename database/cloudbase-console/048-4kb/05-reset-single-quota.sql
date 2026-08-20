-- 048 fallback, 05/15. Run only after file 04 committed.
BEGIN;
CREATE OR REPLACE FUNCTION public.reset_teacher_experience_quota(
  p_quota_id BIGINT,
  p_effective_month DATE DEFAULT public.teacher_experience_quota_month(),
  p_reset_by_account_id BIGINT DEFAULT NULL
)
RETURNS public.teacher_product_experience_quotas
LANGUAGE plpgsql AS $$
DECLARE
  quota public.teacher_product_experience_quotas%ROWTYPE;
  prior_month DATE;
  prior_available INTEGER;
BEGIN
  IF p_effective_month <> DATE_TRUNC('month', p_effective_month)::DATE THEN
    RAISE EXCEPTION 'effective quota month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO quota FROM public.teacher_product_experience_quotas
   WHERE id = p_quota_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher experience quota does not exist' USING ERRCODE = 'P0002';
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
COMMIT;

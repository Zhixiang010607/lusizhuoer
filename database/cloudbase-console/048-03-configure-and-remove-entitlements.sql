-- CloudBase migration 048, part 3 / 7. Run this file by itself.
BEGIN;
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

COMMIT;

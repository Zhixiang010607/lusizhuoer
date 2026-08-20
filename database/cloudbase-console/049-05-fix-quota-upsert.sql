-- CloudBase migration 049, part 5 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.upsert_teacher_product_experience_quota(
  p_teacher_id BIGINT, p_product_id BIGINT, p_monthly_allowance INTEGER,
  p_actor_account_id BIGINT
)
RETURNS TABLE(
  id BIGINT, teacher_id BIGINT, product_id BIGINT, monthly_allowance INTEGER,
  quota_month DATE, available_count INTEGER, used_count INTEGER,
  manual_recharge_count INTEGER, monthly_reset_at TIMESTAMPTZ, created_now BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  quota_row public.teacher_product_experience_quotas%ROWTYPE;
  effective_month DATE := public.teacher_experience_quota_month();
  inserted_now BOOLEAN := FALSE;
  previous_available INTEGER := 0;
BEGIN
  IF p_monthly_allowance IS NULL OR p_monthly_allowance < 0 OR p_monthly_allowance > 1000000 THEN
    RAISE EXCEPTION 'monthly allowance must be an integer from 0 to 1000000' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM public.assert_active_teacher_experience_subjects(p_teacher_id, p_product_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));
  INSERT INTO public.teacher_product_experience_quotas
    (teacher_id, product_id, monthly_allowance, quota_month, available_count,
     used_count, manual_recharge_count, quota_status, created_by_account_id, updated_by_account_id)
  VALUES (p_teacher_id, p_product_id, p_monthly_allowance, effective_month,
          p_monthly_allowance, 0, 0, 'ACTIVE', p_actor_account_id, p_actor_account_id)
  ON CONFLICT ON CONSTRAINT uq_teacher_product_experience_quota DO NOTHING
  RETURNING * INTO quota_row;
  IF FOUND THEN
    inserted_now := TRUE;
  ELSE
    SELECT quota.* INTO quota_row
      FROM public.teacher_product_experience_quotas AS quota
     WHERE quota.teacher_id = p_teacher_id AND quota.product_id = p_product_id
     FOR UPDATE;
    previous_available := quota_row.available_count;
    UPDATE public.teacher_product_experience_quotas AS quota
       SET quota_status = 'ACTIVE', archived_at = NULL, archived_by_account_id = NULL,
           monthly_allowance = p_monthly_allowance, quota_month = effective_month,
           available_count = p_monthly_allowance, used_count = 0, manual_recharge_count = 0,
           monthly_reset_at = CLOCK_TIMESTAMP(), updated_by_account_id = p_actor_account_id,
           updated_at = CLOCK_TIMESTAMP()
     WHERE quota.id = quota_row.id RETURNING quota.* INTO quota_row;
  END IF;
  INSERT INTO public.teacher_experience_quota_configuration_events
    (quota_id, teacher_id, product_id, event_type, monthly_allowance, quota_month,
     available_before_count, available_after_count, occurred_by_account_id)
  VALUES (quota_row.id, quota_row.teacher_id, quota_row.product_id, 'CONFIGURED',
          quota_row.monthly_allowance, quota_row.quota_month, previous_available,
          quota_row.available_count, p_actor_account_id);
  RETURN QUERY SELECT quota_row.id, quota_row.teacher_id, quota_row.product_id,
    quota_row.monthly_allowance, quota_row.quota_month, quota_row.available_count,
    quota_row.used_count, quota_row.manual_recharge_count, quota_row.monthly_reset_at, inserted_now;
END;
$$;

COMMIT;

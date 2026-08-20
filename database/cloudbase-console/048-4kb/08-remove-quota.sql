-- 048 fallback, 08/15. Removal archives the live entitlement; it never deletes history.
BEGIN;
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
LANGUAGE plpgsql AS $$
DECLARE
  quota public.teacher_product_experience_quotas%ROWTYPE;
  removed_at_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));
  SELECT * INTO quota FROM public.teacher_product_experience_quotas
   WHERE teacher_id = p_teacher_id
     AND product_id = p_product_id
     AND quota_status = 'ACTIVE'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no active experience quota for this product' USING ERRCODE = 'P0002';
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
    (quota_id, teacher_id, product_id, event_type, monthly_allowance, quota_month,
     available_before_count, available_after_count, occurred_by_account_id, occurred_at)
  VALUES
    (quota.id, quota.teacher_id, quota.product_id, 'REMOVED', quota.monthly_allowance,
     quota.quota_month, quota.available_count, quota.available_count,
     p_actor_account_id, removed_at_value);
  RETURN QUERY SELECT quota.id, quota.teacher_id, quota.product_id,
    quota.available_count, removed_at_value;
END;
$$;
COMMIT;

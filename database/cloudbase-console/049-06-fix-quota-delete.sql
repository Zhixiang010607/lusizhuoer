-- CloudBase migration 049, part 6 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.delete_teacher_product_experience_quota(
  p_teacher_id BIGINT, p_product_id BIGINT, p_actor_account_id BIGINT
)
RETURNS TABLE(
  quota_id BIGINT, teacher_id BIGINT, product_id BIGINT,
  available_count INTEGER, removed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  quota_row public.teacher_product_experience_quotas%ROWTYPE;
  removed_at_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));
  SELECT quota.* INTO quota_row FROM public.teacher_product_experience_quotas AS quota
   WHERE quota.teacher_id = p_teacher_id AND quota.product_id = p_product_id
     AND quota.quota_status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no active experience quota for this product' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.teacher_product_experience_quotas AS quota
     SET quota_status = 'ARCHIVED', archived_at = removed_at_value,
         archived_by_account_id = p_actor_account_id, updated_by_account_id = p_actor_account_id,
         updated_at = removed_at_value
   WHERE quota.id = quota_row.id RETURNING quota.* INTO quota_row;
  INSERT INTO public.teacher_experience_quota_configuration_events
    (quota_id, teacher_id, product_id, event_type, monthly_allowance, quota_month,
     available_before_count, available_after_count, occurred_by_account_id, occurred_at)
  VALUES (quota_row.id, quota_row.teacher_id, quota_row.product_id, 'REMOVED',
          quota_row.monthly_allowance, quota_row.quota_month, quota_row.available_count,
          quota_row.available_count, p_actor_account_id, removed_at_value);
  RETURN QUERY SELECT quota_row.id, quota_row.teacher_id, quota_row.product_id,
    quota_row.available_count, removed_at_value;
END;
$$;

COMMIT;

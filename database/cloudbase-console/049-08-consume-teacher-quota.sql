-- CloudBase migration 049, part 8 / 13. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.consume_teacher_experience_quota(
  p_verification_id BIGINT, p_teacher_id BIGINT, p_product_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  quota_row public.teacher_product_experience_quotas%ROWTYPE;
  quota_before INTEGER;
BEGIN
  SELECT quota.* INTO quota_row FROM public.teacher_product_experience_quotas AS quota
   WHERE quota.teacher_id = p_teacher_id AND quota.product_id = p_product_id
     AND quota.quota_status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no active configured experience quota for this product' USING ERRCODE = '23514';
  END IF;
  quota_row := public.reset_teacher_experience_quota(
    quota_row.id, public.teacher_experience_quota_month(), NULL
  );
  IF quota_row.available_count < 1 THEN
    RAISE EXCEPTION 'insufficient teacher experience quota for this product' USING ERRCODE = '23514';
  END IF;
  quota_before := quota_row.available_count;
  UPDATE public.teacher_product_experience_quotas AS quota
     SET available_count = quota.available_count - 1, used_count = quota.used_count + 1,
         updated_at = CLOCK_TIMESTAMP()
   WHERE quota.id = quota_row.id RETURNING quota.* INTO quota_row;
  INSERT INTO public.teacher_experience_quota_usages
    (verification_id, quota_id, teacher_id, product_id, quota_month, unit_count,
     available_before_count, available_after_count)
  VALUES (p_verification_id, quota_row.id, p_teacher_id, p_product_id,
          quota_row.quota_month, 1, quota_before, quota_row.available_count);
END;
$$;

COMMIT;

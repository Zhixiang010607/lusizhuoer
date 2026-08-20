-- CloudBase migration 048, part 4 / 7. Run this file by itself.
BEGIN;
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

COMMIT;

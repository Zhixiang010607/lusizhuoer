-- CloudBase migration 050, part 6 / 7. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.recharge_teacher_product_experience_quota(
 p_teacher_id BIGINT,p_product_id BIGINT,p_unit_count INTEGER,p_note TEXT,p_idempotency_key VARCHAR,p_actor_account_id BIGINT)
RETURNS TABLE(recharge_id BIGINT,created_now BOOLEAN,quota_id BIGINT,quota_month DATE,available_before_count INTEGER,
 available_after_count INTEGER,monthly_allowance INTEGER,used_count INTEGER,manual_recharge_count INTEGER,created_at TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE
 q public.teacher_product_experience_quotas%ROWTYPE;
 r public.teacher_experience_quota_recharges%ROWTYPE;
 m DATE:=public.teacher_experience_quota_month(); n TEXT; b INTEGER;
BEGIN
 n:=public.validate_teacher_experience_quota_recharge(p_unit_count,p_note,p_idempotency_key);
 PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
 PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-recharge:'||p_idempotency_key));
 PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:'||p_teacher_id::TEXT||':'||p_product_id::TEXT));
 SELECT recharge.* INTO r FROM public.teacher_experience_quota_recharges AS recharge
  WHERE recharge.idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF r.teacher_id<>p_teacher_id OR r.product_id<>p_product_id OR r.unit_count<>p_unit_count
   OR r.note<>n OR r.recharged_by_account_id<>p_actor_account_id THEN
   RAISE EXCEPTION 'idempotency key belongs to a different teacher experience recharge' USING ERRCODE='23505';
  END IF;
  SELECT quota.* INTO q FROM public.teacher_product_experience_quotas AS quota WHERE quota.id=r.quota_id;
  RETURN QUERY SELECT r.id,FALSE,r.quota_id,r.quota_month,r.available_before_count,r.available_after_count,
   q.monthly_allowance,q.used_count,q.manual_recharge_count,r.created_at; RETURN;
 END IF;
 PERFORM public.assert_active_teacher_experience_subjects(p_teacher_id,p_product_id);
 SELECT quota.* INTO q FROM public.teacher_product_experience_quotas AS quota
  WHERE quota.teacher_id=p_teacher_id AND quota.product_id=p_product_id
   AND quota.quota_status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'teacher has no active configured experience quota for this product' USING ERRCODE='23514'; END IF;
 q:=public.reset_teacher_experience_quota(q.id,m,p_actor_account_id);
 IF q.quota_status<>'ACTIVE' THEN RAISE EXCEPTION 'teacher has no active configured experience quota for this product' USING ERRCODE='23514'; END IF;
 b:=q.available_count;
 UPDATE public.teacher_product_experience_quotas AS quota_target
  SET available_count=quota_target.available_count+p_unit_count,
      manual_recharge_count=quota_target.manual_recharge_count+p_unit_count,
      updated_by_account_id=p_actor_account_id,updated_at=CLOCK_TIMESTAMP()
  WHERE quota_target.id=q.id AND quota_target.quota_status='ACTIVE' RETURNING quota_target.* INTO q;
 INSERT INTO public.teacher_experience_quota_recharges AS recharge_target
  (quota_id,teacher_id,product_id,quota_month,unit_count,available_before_count,
   available_after_count,note,idempotency_key,recharged_by_account_id)
 VALUES(q.id,p_teacher_id,p_product_id,q.quota_month,p_unit_count,b,q.available_count,n,p_idempotency_key,p_actor_account_id)
 RETURNING recharge_target.* INTO r;
 RETURN QUERY SELECT r.id,TRUE,q.id,q.quota_month,b,q.available_count,q.monthly_allowance,q.used_count,q.manual_recharge_count,r.created_at;
END;
$$;

COMMIT;

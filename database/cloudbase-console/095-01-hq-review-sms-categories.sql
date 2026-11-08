-- Requires migration094. Run only through the complete production backup gate.
BEGIN;
ALTER TABLE public.hq_review_sms_preferences
  ADD COLUMN purchase boolean NOT NULL DEFAULT false,
  ADD COLUMN recharge boolean NOT NULL DEFAULT false,
  ADD COLUMN refund boolean NOT NULL DEFAULT false,
  ADD COLUMN verification boolean NOT NULL DEFAULT false;
-- Preserve an already explicitly enabled legacy all-four preference.
UPDATE public.hq_review_sms_preferences SET purchase=enabled,recharge=enabled,refund=enabled,verification=enabled;
CREATE OR REPLACE FUNCTION public.get_hq_review_sms_preference_v94(p_actor_uid text, p_target_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.staff_accounts WHERE auth_uid=p_actor_uid AND role_code='hq' AND account_status='ACTIVE') THEN
    RAISE EXCEPTION 'SMS_ONLY_ACTIVE_HQ' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('staffAccountId',a.id::text,'name',a.staff_name,
    'phone',CASE WHEN length(a.phone)>=7 THEN left(a.phone,3)||'****'||right(a.phone,4) ELSE '未绑定手机号' END,
    'active',a.account_status='ACTIVE','enabled',coalesce(p.enabled,false),
    'categories',jsonb_build_object('purchase',coalesce(p.purchase,false),'recharge',coalesce(p.recharge,false),'refund',coalesce(p.refund,false),'verification',coalesce(p.verification,false)),
    'updatedAt',p.updated_at,'deliveryReady',false)
    INTO result FROM public.staff_accounts a LEFT JOIN public.hq_review_sms_preferences p ON p.staff_account_id=a.id
    WHERE a.id=p_target_id AND a.role_code='hq';
  IF result IS NULL THEN RAISE EXCEPTION 'SMS_HQ_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.set_hq_review_sms_categories_v95(p_actor_uid text, p_target_id bigint, p_purchase boolean, p_recharge boolean, p_refund boolean, p_verification boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor_id bigint; target_status text; p_enabled boolean;
BEGIN
  -- Lock both identities in a stable order, including cross-HQ simultaneous edits.
  PERFORM id FROM public.staff_accounts WHERE auth_uid=p_actor_uid OR id=p_target_id ORDER BY id FOR UPDATE;
  SELECT id INTO actor_id FROM public.staff_accounts WHERE auth_uid=p_actor_uid AND role_code='hq' AND account_status='ACTIVE';
  IF actor_id IS NULL THEN RAISE EXCEPTION 'SMS_ONLY_ACTIVE_HQ' USING ERRCODE='42501'; END IF;
  IF p_purchase IS NULL OR p_recharge IS NULL OR p_refund IS NULL OR p_verification IS NULL THEN RAISE EXCEPTION 'SMS_INVALID_STATE' USING ERRCODE='22023'; END IF;
  p_enabled := p_purchase OR p_recharge OR p_refund OR p_verification;
  SELECT account_status INTO target_status FROM public.staff_accounts WHERE id=p_target_id AND role_code='hq';
  IF target_status IS NULL THEN RAISE EXCEPTION 'SMS_HQ_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_enabled AND target_status<>'ACTIVE' THEN RAISE EXCEPTION 'SMS_HQ_ARCHIVED' USING ERRCODE='23514'; END IF;
  INSERT INTO public.hq_review_sms_preferences(staff_account_id,enabled,updated_by_account_id,purchase,recharge,refund,verification)
    VALUES(p_target_id,p_enabled,actor_id,p_purchase,p_recharge,p_refund,p_verification)
    ON CONFLICT(staff_account_id) DO UPDATE SET enabled=excluded.enabled,updated_by_account_id=excluded.updated_by_account_id,updated_at=now(),purchase=excluded.purchase,recharge=excluded.recharge,refund=excluded.refund,verification=excluded.verification;
  RETURN public.get_hq_review_sms_preference_v94(p_actor_uid,p_target_id);
END;
$$;
CREATE OR REPLACE FUNCTION public.set_hq_review_sms_preference_v94(p_actor_uid text,p_target_id bigint,p_enabled boolean)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.set_hq_review_sms_categories_v95(p_actor_uid,p_target_id,p_enabled,p_enabled,p_enabled,p_enabled);
$$;
REVOKE ALL ON FUNCTION public.set_hq_review_sms_categories_v95(text,bigint,boolean,boolean,boolean,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_hq_review_sms_categories_v95(text,bigint,boolean,boolean,boolean,boolean) TO service_role;
COMMIT;

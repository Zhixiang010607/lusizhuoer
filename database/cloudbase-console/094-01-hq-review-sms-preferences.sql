-- Run only through scripts/cloudbase-pg-change.js after 094-preview.sql.
BEGIN;
CREATE TABLE public.hq_review_sms_preferences (
  staff_account_id bigint PRIMARY KEY REFERENCES public.staff_accounts(id),
  enabled boolean NOT NULL DEFAULT false,
  updated_by_account_id bigint NOT NULL REFERENCES public.staff_accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.hq_review_sms_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hq_review_sms_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hq_review_sms_preferences TO service_role;

CREATE FUNCTION public.get_hq_review_sms_preference_v94(p_actor_uid text, p_target_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.staff_accounts WHERE auth_uid=p_actor_uid AND role_code='hq' AND account_status='ACTIVE') THEN
    RAISE EXCEPTION 'SMS_ONLY_ACTIVE_HQ' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('staffAccountId',a.id::text,'name',a.staff_name,
    'phone',CASE WHEN length(a.phone)>=7 THEN left(a.phone,3)||'****'||right(a.phone,4) ELSE '未绑定手机号' END,
    'active',a.account_status='ACTIVE','enabled',coalesce(p.enabled,false),
    'updatedAt',p.updated_at,'deliveryReady',false)
    INTO result FROM public.staff_accounts a LEFT JOIN public.hq_review_sms_preferences p ON p.staff_account_id=a.id
    WHERE a.id=p_target_id AND a.role_code='hq';
  IF result IS NULL THEN RAISE EXCEPTION 'SMS_HQ_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.set_hq_review_sms_preference_v94(p_actor_uid text, p_target_id bigint, p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor_id bigint; target_status text;
BEGIN
  -- Lock both identities in a stable order, including cross-HQ simultaneous edits.
  PERFORM id FROM public.staff_accounts WHERE auth_uid=p_actor_uid OR id=p_target_id ORDER BY id FOR UPDATE;
  SELECT id INTO actor_id FROM public.staff_accounts WHERE auth_uid=p_actor_uid AND role_code='hq' AND account_status='ACTIVE';
  IF actor_id IS NULL THEN RAISE EXCEPTION 'SMS_ONLY_ACTIVE_HQ' USING ERRCODE='42501'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'SMS_INVALID_STATE' USING ERRCODE='22023'; END IF;
  SELECT account_status INTO target_status FROM public.staff_accounts WHERE id=p_target_id AND role_code='hq';
  IF target_status IS NULL THEN RAISE EXCEPTION 'SMS_HQ_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_enabled AND target_status<>'ACTIVE' THEN RAISE EXCEPTION 'SMS_HQ_ARCHIVED' USING ERRCODE='23514'; END IF;
  INSERT INTO public.hq_review_sms_preferences(staff_account_id,enabled,updated_by_account_id)
    VALUES(p_target_id,p_enabled,actor_id)
    ON CONFLICT(staff_account_id) DO UPDATE SET enabled=excluded.enabled,updated_by_account_id=excluded.updated_by_account_id,updated_at=now();
  RETURN public.get_hq_review_sms_preference_v94(p_actor_uid,p_target_id);
END;
$$;
REVOKE ALL ON FUNCTION public.get_hq_review_sms_preference_v94(text,bigint), public.set_hq_review_sms_preference_v94(text,bigint,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_hq_review_sms_preference_v94(text,bigint), public.set_hq_review_sms_preference_v94(text,bigint,boolean) TO service_role;
COMMIT;

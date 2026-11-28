-- Executed 2026-11-28 after verified backup; do not rerun. See 097-README.md.
-- First activation only; 094/095/096 must already exist. Do not rerun them.
-- Run ONLY through scripts/cloudbase-pg-change.js with a NEW complete backup.
-- Scope: one delivery-state row; no preference, business, or outbox mutation.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
LOCK TABLE public.hq_review_sms_delivery_state IN EXCLUSIVE MODE;
LOCK TABLE public.hq_review_sms_outbox IN SHARE ROW EXCLUSIVE MODE;
DO $activation$
DECLARE changed integer;
BEGIN
  IF (SELECT count(*) FROM public.hq_review_sms_delivery_state) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.hq_review_sms_delivery_state
       WHERE singleton AND NOT enabled AND activated_at IS NULL AND sdk_app_id='1401179904') THEN
    RAISE EXCEPTION 'SMS_FIRST_ACTIVATION_STATE_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM public.hq_review_sms_outbox) THEN
    RAISE EXCEPTION 'SMS_FIRST_ACTIVATION_REQUIRES_EMPTY_OUTBOX';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND tgname IN ('enqueue_purchase_review_sms','enqueue_recharge_review_sms',
      'enqueue_verification_review_sms')) <> 3 THEN
    RAISE EXCEPTION 'SMS_INSERT_TRIGGERS_NOT_READY';
  END IF;
  IF to_regprocedure('public.claim_hq_review_sms_v96(text)') IS NULL
     OR to_regprocedure('public.start_hq_review_sms_v96(bigint,text)') IS NULL
     OR to_regprocedure('public.finish_hq_review_sms_v96(bigint,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'SMS_WORKER_FUNCTIONS_NOT_READY';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN (VALUES
      ('hq_review_sms_phone_v96','2f2bfd766a419b16dbcf8a953a7ba4c7'),
      ('enqueue_hq_review_sms_v96','5908334d38dd3ebca65580a295575c90'),
      ('hq_review_sms_eligible_v96','420b8ed60754867d65a23d40c1bddd84'),
      ('claim_hq_review_sms_v96','82c0a05c22c9a1f2fdda734022855a7e'),
      ('start_hq_review_sms_v96','84d9ce59d68fb6f82b8429fe5d3d4726'),
      ('finish_hq_review_sms_v96','84bb1dfb46338d44c91d3d717898e481')
    ) expected(name,body_hash) ON p.proname=expected.name
    WHERE n.nspname='public' AND md5(p.prosrc)=expected.body_hash) <> 6 THEN
    RAISE EXCEPTION 'SMS_ROUTINE_BODY_CHANGED_REVIEW_REQUIRED';
  END IF;
  UPDATE public.hq_review_sms_delivery_state
    SET enabled=true, activated_at=clock_timestamp()
    WHERE singleton AND NOT enabled AND activated_at IS NULL AND sdk_app_id='1401179904';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'SMS_ACTIVATION_UNCONFIRMED'; END IF;
END
$activation$;
COMMIT;

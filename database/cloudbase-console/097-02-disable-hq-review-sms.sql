-- Emergency stop, never a normal second step after activation.
-- Run ONLY through scripts/cloudbase-pg-change.js with its OWN NEW complete backup.
-- Preserve activated_at, preferences, outbox, provider receipts and all business data.
-- An already dispatched request cannot be recalled; do not infer non-delivery.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
LOCK TABLE public.hq_review_sms_delivery_state IN EXCLUSIVE MODE;
DO $disable$
BEGIN
  IF (SELECT count(*) FROM public.hq_review_sms_delivery_state) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.hq_review_sms_delivery_state
       WHERE singleton AND sdk_app_id='1401179904') THEN
    RAISE EXCEPTION 'SMS_DELIVERY_STATE_MISMATCH';
  END IF;
  UPDATE public.hq_review_sms_delivery_state SET enabled=false
    WHERE singleton AND enabled AND sdk_app_id='1401179904';
END
$disable$;
COMMIT;

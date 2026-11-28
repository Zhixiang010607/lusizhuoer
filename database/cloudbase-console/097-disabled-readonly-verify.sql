-- Read-only after emergency stop or while activation is still blocked.
SELECT 'delivery_disabled' AS check_name,
  CASE WHEN count(*)=1 AND bool_and(NOT enabled AND sdk_app_id='1401179904')
    THEN 'READY' ELSE 'FAIL' END AS status FROM public.hq_review_sms_delivery_state
UNION ALL SELECT 'queued_jobs_cannot_start', CASE WHEN count(*)=0 THEN 'READY' ELSE 'FAIL' END
  FROM public.hq_review_sms_outbox WHERE status IN ('PENDING','CLAIMED')
    AND public.hq_review_sms_eligible_v96(id);

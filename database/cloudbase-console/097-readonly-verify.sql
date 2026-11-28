-- Independent read-only post-activation checks. Never invokes a worker.
SELECT 'delivery_enabled' AS check_name,
  CASE WHEN count(*)=1 AND bool_and(enabled AND activated_at IS NOT NULL
    AND sdk_app_id='1401179904') THEN 'READY' ELSE 'NOT_ENABLED' END AS status
  FROM public.hq_review_sms_delivery_state
UNION ALL SELECT 'three_insert_triggers', CASE WHEN count(*)=3 THEN 'READY' ELSE 'FAIL' END
  FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN
    ('enqueue_purchase_review_sms','enqueue_recharge_review_sms','enqueue_verification_review_sms')
UNION ALL SELECT 'no_pre_activation_jobs', CASE WHEN count(*)=0 THEN 'READY' ELSE 'FAIL' END
  FROM public.hq_review_sms_outbox q CROSS JOIN public.hq_review_sms_delivery_state d
  WHERE q.created_at < d.activated_at
UNION ALL SELECT 'single_attempt_only', CASE WHEN count(*)=0 THEN 'READY' ELSE 'FAIL' END
  FROM public.hq_review_sms_outbox WHERE attempt_count NOT BETWEEN 0 AND 1
UNION ALL SELECT 'private_sms_tables', CASE WHEN count(*)=2 AND bool_and(relrowsecurity)
    THEN 'READY' ELSE 'FAIL' END FROM pg_class WHERE oid IN
    ('public.hq_review_sms_delivery_state'::regclass,'public.hq_review_sms_outbox'::regclass)
UNION ALL SELECT 'client_schema_denied', CASE WHEN
    NOT has_schema_privilege('anon','public','USAGE')
    AND NOT has_schema_privilege('authenticated','public','USAGE') THEN 'READY' ELSE 'FAIL' END
UNION ALL SELECT 'client_sms_privileges_denied', CASE WHEN NOT EXISTS (
  SELECT 1 FROM pg_roles r CROSS JOIN (VALUES
    ('public.hq_review_sms_delivery_state'),('public.hq_review_sms_outbox')) t(table_name)
  WHERE r.rolname IN ('anon','authenticated')
    AND has_table_privilege(r.rolname,t.table_name,'SELECT,INSERT,UPDATE,DELETE'))
  AND NOT EXISTS (SELECT 1 FROM pg_roles r CROSS JOIN (VALUES
    ('public.claim_hq_review_sms_v96(text)'),('public.start_hq_review_sms_v96(bigint,text)'),
    ('public.finish_hq_review_sms_v96(bigint,text,text,text,text,text)')) f(signature)
  WHERE r.rolname IN ('anon','authenticated') AND has_function_privilege(r.rolname,f.signature,'EXECUTE'))
  THEN 'READY' ELSE 'FAIL' END
UNION ALL SELECT 'service_role_worker_access', CASE WHEN
    has_table_privilege('service_role','public.hq_review_sms_delivery_state','SELECT')
    AND has_function_privilege('service_role','public.claim_hq_review_sms_v96(text)','EXECUTE')
    AND has_function_privilege('service_role','public.start_hq_review_sms_v96(bigint,text)','EXECUTE')
    AND has_function_privilege('service_role','public.finish_hq_review_sms_v96(bigint,text,text,text,text,text)','EXECUTE')
  THEN 'READY' ELSE 'FAIL' END;

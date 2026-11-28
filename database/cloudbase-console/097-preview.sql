-- Read-only activation preview. Does not send, enqueue, or change preferences.
SELECT jsonb_build_object(
  'database', current_database(),
  'delivery', (SELECT jsonb_build_object('enabled', enabled, 'sdk_app_id', sdk_app_id,
    'activated_at', activated_at) FROM public.hq_review_sms_delivery_state WHERE singleton),
  'public_base_tables', (SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'),
  'public_sequences', (SELECT count(*) FROM pg_sequences WHERE schemaname='public'),
  'active_hq', (SELECT count(*) FROM public.staff_accounts
    WHERE role_code='hq' AND account_status='ACTIVE'),
  'active_preferences', (SELECT jsonb_build_object(
    'any_enabled', count(*) FILTER (WHERE p.enabled),
    'purchase', count(*) FILTER (WHERE p.enabled AND p.purchase),
    'recharge', count(*) FILTER (WHERE p.enabled AND p.recharge),
    'refund', count(*) FILTER (WHERE p.enabled AND p.refund),
    'verification', count(*) FILTER (WHERE p.enabled AND p.verification),
    'invalid_bound_phone', count(*) FILTER (WHERE p.enabled AND public.hq_review_sms_phone_v96(a.phone) IS NULL),
    'inconsistent_flags', count(*) FILTER (WHERE p.enabled IS DISTINCT FROM
      (p.purchase OR p.recharge OR p.refund OR p.verification)))
    FROM public.staff_accounts a LEFT JOIN public.hq_review_sms_preferences p ON p.staff_account_id=a.id
    WHERE a.role_code='hq' AND a.account_status='ACTIVE' AND p.staff_account_id IS NOT NULL),
  'outbox', (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
    FROM (SELECT status, count(*) AS n FROM public.hq_review_sms_outbox GROUP BY status) s),
  'triggers', (SELECT jsonb_agg(jsonb_build_object('name', tgname, 'enabled', tgenabled,
    'definition', pg_get_triggerdef(oid)) ORDER BY tgname) FROM pg_trigger
    WHERE NOT tgisinternal AND tgname IN ('enqueue_purchase_review_sms',
      'enqueue_recharge_review_sms', 'enqueue_verification_review_sms')),
  'function_hashes', (SELECT jsonb_object_agg(p.proname, md5(pg_get_functiondef(p.oid)))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('hq_review_sms_phone_v96',
      'enqueue_hq_review_sms_v96', 'hq_review_sms_eligible_v96', 'claim_hq_review_sms_v96',
      'start_hq_review_sms_v96', 'finish_hq_review_sms_v96')),
  'protected_fingerprints', (SELECT jsonb_agg(row_to_json(f)) FROM (
    SELECT 'staff_accounts' AS table_name, count(*) AS rows,
      md5(string_agg(row_to_json(r)::text, '|' ORDER BY id)) AS fingerprint FROM public.staff_accounts r
    UNION ALL SELECT 'hq_review_sms_preferences', count(*),
      md5(string_agg(row_to_json(r)::text, '|' ORDER BY staff_account_id)) FROM public.hq_review_sms_preferences r
    UNION ALL SELECT 'recharge_records', count(*),
      md5(string_agg(row_to_json(r)::text, '|' ORDER BY id)) FROM public.recharge_records r
    UNION ALL SELECT 'verification_records', count(*),
      md5(string_agg(row_to_json(r)::text, '|' ORDER BY id)) FROM public.verification_records r
    UNION ALL SELECT 'retail_product_purchase_records', count(*),
      md5(string_agg(row_to_json(r)::text, '|' ORDER BY id)) FROM public.retail_product_purchase_records r
  ) f)
) AS preview;

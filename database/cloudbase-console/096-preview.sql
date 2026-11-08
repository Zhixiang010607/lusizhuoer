SELECT jsonb_build_object('database',current_database(),'database_user',current_user,
 'preferences_ready',to_regclass('public.hq_review_sms_preferences') IS NOT NULL,
 'outbox_absent',to_regclass('public.hq_review_sms_outbox') IS NULL,
 'delivery_state_absent',to_regclass('public.hq_review_sms_delivery_state') IS NULL,
 'required_columns',(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='hq_review_sms_preferences' AND column_name IN ('purchase','recharge','refund','verification')) OR (table_name IN ('recharge_records','verification_records','retail_product_purchase_records') AND column_name IN ('id','submitted_at','record_status')) OR (table_name='recharge_records' AND column_name='recharge_type') OR (table_name='verification_records' AND column_name IN ('verification_type','void_request_status')))),
 'fingerprints',(SELECT jsonb_agg(row_to_json(f)) FROM (SELECT 'staff_accounts' AS table_name,count(*) AS rows,md5(string_agg(row_to_json(r)::text,'|' ORDER BY id)) AS fingerprint FROM public.staff_accounts r
UNION ALL SELECT 'hq_review_sms_preferences',count(*),md5(string_agg(row_to_json(r)::text,'|' ORDER BY staff_account_id)) FROM public.hq_review_sms_preferences r
UNION ALL SELECT 'recharge_records',count(*),md5(string_agg(row_to_json(r)::text,'|' ORDER BY id)) FROM public.recharge_records r
UNION ALL SELECT 'verification_records',count(*),md5(string_agg(row_to_json(r)::text,'|' ORDER BY id)) FROM public.verification_records r
UNION ALL SELECT 'retail_product_purchase_records',count(*),md5(string_agg(row_to_json(r)::text,'|' ORDER BY id)) FROM public.retail_product_purchase_records r) f)) AS preview;

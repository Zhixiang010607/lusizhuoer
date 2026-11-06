-- Read-only ledger reconciliation. No writes, refresh functions, resets or identifiers.
-- The two history counters are inventory, not failures; all mismatch/invalid/orphan counters must be zero.
SELECT jsonb_build_object(
 'environment_database',current_database(),
 'balance_mismatches',(SELECT count(*) FROM (
   WITH r AS (SELECT customer_id,product_id,GREATEST(SUM(CASE WHEN recharge_type='NEW' THEN unit_count ELSE -unit_count END),0)::bigint AS purchased
      FROM public.recharge_records WHERE record_status='APPROVED' GROUP BY customer_id,product_id),
   v AS (SELECT customer_id,product_id,SUM(unit_count)::bigint AS consumed FROM public.verification_records WHERE record_status='APPROVED' AND verification_type IN ('NORMAL','SUPPLEMENT') GROUP BY customer_id,product_id),
   expected AS (SELECT COALESCE(r.customer_id,v.customer_id) customer_id,COALESCE(r.product_id,v.product_id) product_id,
     COALESCE(purchased,0) purchased,COALESCE(consumed,0) consumed,GREATEST(COALESCE(purchased,0)-COALESCE(consumed,0),0) remaining
     FROM r FULL JOIN v USING(customer_id,product_id))
   SELECT e.customer_id FROM expected e FULL JOIN public.customer_product_balances b USING(customer_id,product_id)
    WHERE COALESCE(e.purchased,0)<>COALESCE(b.total_recharge_count,0) OR COALESCE(e.consumed,0)<>COALESCE(b.total_verification_count,0) OR COALESCE(e.remaining,0)<>COALESCE(b.remaining_count,0)
 ) checked),
 'customer_cache_mismatches',(SELECT count(*) FROM public.customers c WHERE
   c.total_recharge_count<>COALESCE((SELECT SUM(b.total_recharge_count) FROM public.customer_product_balances b WHERE b.customer_id=c.id),0)
   OR c.total_verification_count<>COALESCE((SELECT SUM(v.unit_count) FROM public.verification_records v WHERE v.customer_id=c.id AND v.record_status='APPROVED' AND v.verification_type IN ('NORMAL','SUPPLEMENT','EXPERIENCE')),0)
   OR c.total_experience_count<>COALESCE((SELECT SUM(v.unit_count) FROM public.verification_records v WHERE v.customer_id=c.id AND v.record_status='APPROVED' AND v.verification_type='EXPERIENCE'),0)),
 'invalid_units',(SELECT count(*) FROM (SELECT unit_count FROM public.recharge_records UNION ALL SELECT unit_count FROM public.verification_records UNION ALL SELECT unit_count FROM public.retail_product_purchase_records UNION ALL SELECT unit_count FROM public.recharge_product_gifts) x WHERE unit_count NOT BETWEEN 1 AND 999 OR unit_count IS NULL),
 'orphan_business_references',(SELECT count(*) FROM (
   SELECT customer_id,store_id,product_id,teacher_id,submitted_by_account_id FROM public.recharge_records
   UNION ALL SELECT customer_id,store_id,product_id,teacher_id,submitted_by_account_id FROM public.verification_records
 ) x LEFT JOIN public.customers c ON c.id=x.customer_id LEFT JOIN public.stores s ON s.id=x.store_id LEFT JOIN public.products p ON p.id=x.product_id LEFT JOIN public.teachers t ON t.id=x.teacher_id LEFT JOIN public.staff_accounts a ON a.id=x.submitted_by_account_id
 WHERE c.id IS NULL OR s.id IS NULL OR p.id IS NULL OR a.id IS NULL OR (x.teacher_id IS NOT NULL AND t.id IS NULL)),
 'duplicate_request_keys',(SELECT count(*) FROM (SELECT 'R' family,idempotency_key FROM public.recharge_records WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING count(*)>1 UNION ALL SELECT 'V',idempotency_key FROM public.verification_records WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING count(*)>1) duplicates),
 'negative_balances',(SELECT count(*) FROM public.customer_product_balances WHERE remaining_count<0),
 'latest_time_mismatches',(SELECT count(*) FROM public.customers c WHERE c.latest_recharge_at IS DISTINCT FROM (SELECT MAX(r.submitted_at) FROM public.recharge_records r WHERE r.customer_id=c.id AND r.record_status='APPROVED' AND r.recharge_type='NEW') OR c.latest_verification_at IS DISTINCT FROM (SELECT MAX(v.submitted_at) FROM public.verification_records v WHERE v.customer_id=c.id AND v.record_status='APPROVED' AND v.verification_type IN ('NORMAL','SUPPLEMENT','EXPERIENCE'))),
 'historical_stage_mismatches',(SELECT count(*) FROM public.customers c WHERE c.customer_process_status IS DISTINCT FROM CASE
   WHEN NOT EXISTS (SELECT 1 FROM public.recharge_records r WHERE r.customer_id=c.id AND r.record_status='APPROVED' AND r.recharge_type='NEW') THEN 'INFORMATION_ONLY'
   WHEN NOT EXISTS (SELECT 1 FROM public.verification_records v WHERE v.customer_id=c.id AND v.record_status='APPROVED' AND v.verification_type IN ('NORMAL','SUPPLEMENT')) THEN 'RECHARGED_NO_CONSUMPTION'
   ELSE 'RECHARGED_WITH_CONSUMPTION' END),
 'customers_with_experience_history',(SELECT count(*) FROM public.customers c WHERE c.total_experience_count>0),
 'customers_with_approved_refunds',(SELECT count(DISTINCT customer_id) FROM public.recharge_records WHERE recharge_type='REFUND' AND record_status='APPROVED')
) AS audit;

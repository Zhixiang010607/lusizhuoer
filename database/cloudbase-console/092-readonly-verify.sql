-- SELECT only. Both checks must be READY after the gated migration.
SELECT 'historical_customer_stage' AS check_name,
       CASE WHEN count(*)=0 THEN 'READY' ELSE 'MISMATCH' END AS status,
       count(*) AS mismatch_count
FROM public.customers c WHERE c.customer_process_status IS DISTINCT FROM CASE
    WHEN NOT EXISTS (SELECT 1 FROM public.recharge_records r
                     WHERE r.customer_id = c.id AND r.record_status = 'APPROVED' AND r.recharge_type = 'NEW')
      THEN 'INFORMATION_ONLY'
    WHEN NOT EXISTS (SELECT 1 FROM public.verification_records v
                     WHERE v.customer_id = c.id AND v.record_status = 'APPROVED'
                       AND v.verification_type IN ('NORMAL', 'SUPPLEMENT'))
      THEN 'RECHARGED_NO_CONSUMPTION'
    ELSE 'RECHARGED_WITH_CONSUMPTION'
  END;
SELECT 'historical_stage_refresh_function' AS check_name,
       CASE WHEN pg_get_functiondef('public.refresh_customer_balance(bigint)'::regprocedure)
         LIKE '%WHEN NOT EXISTS (SELECT 1 FROM public.recharge_records r%'
         THEN 'READY' ELSE 'MISMATCH' END AS status;

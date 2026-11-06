-- SELECT only. Confirm the environment passed to the CLI separately.
SELECT current_database() AS database_name,
       (SELECT count(*) FROM public.customers) AS customer_count,
       (SELECT count(*) FROM public.recharge_records) AS recharge_rows,
       (SELECT count(*) FROM public.verification_records) AS verification_rows,
       (SELECT count(*) FROM public.customers c WHERE c.customer_process_status IS DISTINCT FROM CASE
    WHEN NOT EXISTS (SELECT 1 FROM public.recharge_records r
                     WHERE r.customer_id = c.id AND r.record_status = 'APPROVED' AND r.recharge_type = 'NEW')
      THEN 'INFORMATION_ONLY'
    WHEN NOT EXISTS (SELECT 1 FROM public.verification_records v
                     WHERE v.customer_id = c.id AND v.record_status = 'APPROVED'
                       AND v.verification_type IN ('NORMAL', 'SUPPLEMENT'))
      THEN 'RECHARGED_NO_CONSUMPTION'
    ELSE 'RECHARGED_WITH_CONSUMPTION'
  END
       ) AS stage_changes;

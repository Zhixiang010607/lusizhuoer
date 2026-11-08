SELECT current_database() AS database_name,
  to_regclass('public.hq_review_sms_preferences') IS NOT NULL AS migration_already_present,
  (SELECT count(*) FROM public.staff_accounts WHERE role_code='hq') AS hq_accounts,
  (SELECT count(*) FROM public.staff_accounts WHERE role_code='hq' AND account_status='ACTIVE') AS active_hq_accounts;

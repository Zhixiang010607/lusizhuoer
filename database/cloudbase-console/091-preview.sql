-- Read-only preview. Confirm the intended database/environment before backup.
SELECT current_database() AS database_name, current_schema() AS schema_name,
  CLOCK_TIMESTAMP() AT TIME ZONE 'Asia/Shanghai' AS shanghai_time,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS public_table_count,
  (SELECT COUNT(*) FROM public.teachers) AS teacher_count,
  (SELECT COUNT(*) FROM public.staff_accounts WHERE role_code='hq' AND account_status='ACTIVE') AS active_hq_count,
  (SELECT COUNT(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) AS required_roles,
  TO_REGCLASS('public.teacher_team_leaders') AS existing_leader_table,
  TO_REGCLASS('public.teacher_team_members') AS existing_member_table,
  TO_REGCLASS('public.teacher_team_events') AS existing_audit_table;

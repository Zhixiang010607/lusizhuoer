-- Read-only; every status must be READY. Existing business rows must also be
-- independently compared with the verified pre-migration backup.
SELECT 'team_tables' AS check_name, CASE WHEN
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
   AND table_name IN ('teacher_team_leaders','teacher_team_members','teacher_team_events'))=3
  THEN 'READY' ELSE 'NOT_READY' END AS status
UNION ALL SELECT 'single_member_owner', CASE WHEN EXISTS (
  SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
  WHERE c.conrelid=TO_REGCLASS('public.teacher_team_members') AND c.contype='p'
    AND ARRAY_LENGTH(c.conkey,1)=1 AND a.attname='member_teacher_id' AND c.convalidated)
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL SELECT 'guard_and_release_triggers', CASE WHEN (SELECT COUNT(*) FROM pg_trigger
  WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN
    ('teacher_team_leader_guard','teacher_team_member_guard','teacher_team_release_on_revoke','teacher_team_audit_immutable')
    AND tgrelid IN (TO_REGCLASS('public.teacher_team_leaders'),TO_REGCLASS('public.teacher_team_members'),TO_REGCLASS('public.teacher_team_events')))=4
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL SELECT 'client_tables_closed', CASE WHEN NOT EXISTS (
  SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace CROSS JOIN
    (VALUES ('anon'),('authenticated')) AS client(role_name)
  WHERE n.nspname='public' AND t.relname IN ('teacher_team_leaders','teacher_team_members','teacher_team_events')
    AND HAS_TABLE_PRIVILEGE(client.role_name,t.oid,'SELECT,INSERT,UPDATE,DELETE'))
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL SELECT 'service_tables_read_only', CASE WHEN (SELECT COUNT(*) FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='public' AND t.relname IN ('teacher_team_leaders','teacher_team_members','teacher_team_events')
    AND HAS_TABLE_PRIVILEGE('service_role',t.oid,'SELECT')
    AND NOT HAS_TABLE_PRIVILEGE('service_role',t.oid,'INSERT,UPDATE,DELETE'))=3
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL SELECT 'private_definer_functions', CASE WHEN (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('set_teacher_team_leader_v91','set_teacher_team_member_v91','is_teacher_team_leader_v91','can_read_teacher_team_member_v91')
    AND p.prosecdef AND HAS_FUNCTION_PRIVILEGE('service_role',p.oid,'EXECUTE')
    AND NOT HAS_FUNCTION_PRIVILEGE('anon',p.oid,'EXECUTE')
    AND NOT HAS_FUNCTION_PRIVILEGE('authenticated',p.oid,'EXECUTE')
    AND p.proconfig @> ARRAY['search_path=public, pg_temp'])=4
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL SELECT 'no_leader_as_member', CASE WHEN NOT EXISTS (
  SELECT 1 FROM public.teacher_team_members m JOIN public.teacher_team_leaders l ON l.teacher_id=m.member_teacher_id WHERE l.enabled)
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL SELECT 'revoked_leaders_have_no_members', CASE WHEN NOT EXISTS (
  SELECT 1 FROM public.teacher_team_members m JOIN public.teacher_team_leaders l ON l.teacher_id=m.leader_teacher_id WHERE NOT l.enabled)
  THEN 'READY' ELSE 'NOT_READY' END
UNION ALL SELECT 'only_teacher_members', CASE WHEN NOT EXISTS (
  SELECT 1 FROM public.teacher_team_members m JOIN public.teachers t ON t.id=m.member_teacher_id
  JOIN public.staff_accounts a ON a.id=t.staff_account_id WHERE a.role_code<>'teacher')
  THEN 'READY' ELSE 'NOT_READY' END;

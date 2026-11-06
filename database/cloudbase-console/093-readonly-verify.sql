-- SELECT only. All five rows must be READY. No production archive is performed.
SELECT 'atomic_status_function' AS check_name,CASE WHEN TO_REGPROCEDURE('public.set_teacher_status_v93(text,bigint,text)') IS NOT NULL THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL SELECT 'leader_name_function',CASE WHEN TO_REGPROCEDURE('public.teacher_team_leader_name_v93(bigint)') IS NOT NULL THEN 'READY' ELSE 'MISSING' END
UNION ALL SELECT 'deferred_archive_guards',CASE WHEN (SELECT count(*) FROM pg_trigger WHERE tgname IN ('teacher_team_archive_guard_v93','teacher_team_account_archive_guard_v93') AND tgdeferrable AND tginitdeferred AND NOT tgisinternal AND tgenabled='O')=2 THEN 'READY' ELSE 'MISSING' END
UNION ALL SELECT 'status_statement_locks',CASE WHEN (SELECT count(*) FROM pg_trigger WHERE tgname IN ('teacher_team_status_lock_v93','teacher_team_account_lock_v93') AND NOT tgisinternal AND tgenabled='O')=2 THEN 'READY' ELSE 'MISSING' END
UNION ALL SELECT 'client_function_access',CASE WHEN
 NOT has_function_privilege('anon','public.set_teacher_status_v93(text,bigint,text)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.set_teacher_status_v93(text,bigint,text)','EXECUTE')
 AND NOT has_function_privilege('anon','public.teacher_team_leader_name_v93(bigint)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.teacher_team_leader_name_v93(bigint)','EXECUTE')
 AND has_function_privilege('service_role','public.set_teacher_status_v93(text,bigint,text)','EXECUTE')
 AND has_function_privilege('service_role','public.teacher_team_leader_name_v93(bigint)','EXECUTE') THEN 'READY' ELSE 'MISMATCH' END;

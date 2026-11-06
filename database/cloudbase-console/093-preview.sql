-- SELECT only. Resolve the environment separately before the backup gate.
SELECT current_database() AS database_name,
 (SELECT count(*) FROM public.teacher_team_members) AS members,
 (SELECT count(*) FROM public.teacher_team_leaders WHERE enabled) AS leaders,
 (SELECT count(*) FROM public.teacher_team_members m
   JOIN public.teachers t ON t.id=m.member_teacher_id JOIN public.staff_accounts a ON a.id=t.staff_account_id
   JOIN public.teachers l ON l.id=m.leader_teacher_id JOIN public.staff_accounts la ON la.id=l.staff_account_id
   JOIN public.teacher_team_leaders tl ON tl.teacher_id=l.id
   WHERE t.teacher_status<>'ACTIVE' OR a.account_status<>'ACTIVE' OR l.teacher_status<>'ACTIVE' OR la.account_status<>'ACTIVE' OR NOT tl.enabled) AS inactive_bindings,
 TO_REGPROCEDURE('public.set_teacher_status_v93(text,bigint,text)') IS NOT NULL AS migration_already_present;

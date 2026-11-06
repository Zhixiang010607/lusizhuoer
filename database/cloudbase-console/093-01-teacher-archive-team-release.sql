-- Teacher archival detaches membership and revokes leadership atomically.
-- Run only through the production full-backup gate after read-only preview.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('teacher-team-membership-v91',0));
LOCK TABLE public.teachers,public.staff_accounts,public.teacher_team_members,public.teacher_team_leaders IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF TO_REGPROCEDURE('public.set_teacher_team_leader_v91(text,bigint,boolean)') IS NULL
    OR TO_REGPROCEDURE('public.sync_teacher_account_status()') IS NULL THEN
    RAISE EXCEPTION '093 requires teacher team and account status synchronization';
  END IF;
  IF EXISTS (SELECT 1 FROM public.teacher_team_members m
      JOIN public.teachers t ON t.id=m.member_teacher_id
      JOIN public.staff_accounts a ON a.id=t.staff_account_id
      JOIN public.teachers leader ON leader.id=m.leader_teacher_id
      JOIN public.staff_accounts la ON la.id=leader.staff_account_id
      JOIN public.teacher_team_leaders l ON l.teacher_id=leader.id
      WHERE t.teacher_status<>'ACTIVE' OR a.account_status<>'ACTIVE' OR NOT l.enabled
         OR leader.teacher_status<>'ACTIVE' OR la.account_status<>'ACTIVE')
    OR EXISTS (SELECT 1 FROM public.teacher_team_leaders l
      JOIN public.teachers t ON t.id=l.teacher_id JOIN public.staff_accounts a ON a.id=t.staff_account_id
      WHERE l.enabled AND (t.teacher_status<>'ACTIVE' OR a.account_status<>'ACTIVE')) THEN
    RAISE EXCEPTION '093 inactive group bindings require exact reviewed cleanup before migration';
  END IF;
END; $$;

CREATE FUNCTION public.lock_teacher_team_status_v93()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-team-membership-v91',0));
  RETURN NULL;
END; $$;
CREATE TRIGGER teacher_team_status_lock_v93 BEFORE UPDATE OF teacher_status ON public.teachers
  FOR EACH STATEMENT EXECUTE FUNCTION public.lock_teacher_team_status_v93();
CREATE TRIGGER teacher_team_account_lock_v93 BEFORE UPDATE OF staff_name,account_status,role_code ON public.staff_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION public.lock_teacher_team_status_v93();

CREATE FUNCTION public.enforce_active_teacher_team_v93()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target_id BIGINT;
BEGIN
  IF TG_TABLE_NAME='teachers' THEN target_id:=NEW.id;
  ELSE SELECT id INTO target_id FROM public.teachers WHERE staff_account_id=NEW.id; END IF;
  IF target_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.teachers t JOIN public.staff_accounts a ON a.id=t.staff_account_id
    WHERE t.id=target_id AND (t.teacher_status<>'ACTIVE' OR a.account_status<>'ACTIVE' OR a.role_code<>'teacher')
      AND (EXISTS(SELECT 1 FROM public.teacher_team_members WHERE member_teacher_id=t.id)
        OR EXISTS(SELECT 1 FROM public.teacher_team_leaders WHERE teacher_id=t.id AND enabled))
  ) THEN RAISE EXCEPTION 'TEAM_ARCHIVE_REQUIRES_ATOMIC_RELEASE' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER teacher_team_archive_guard_v93 AFTER UPDATE OF teacher_status ON public.teachers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_active_teacher_team_v93();
CREATE CONSTRAINT TRIGGER teacher_team_account_archive_guard_v93 AFTER UPDATE OF account_status,role_code ON public.staff_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_active_teacher_team_v93();

CREATE FUNCTION public.set_teacher_status_v93(p_actor_uid TEXT,p_teacher_id BIGINT,p_status TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor_id BIGINT; account_id BIGINT; old_status TEXT; original_leader BIGINT; released_count BIGINT:=0;
BEGIN
  SELECT id INTO actor_id FROM public.staff_accounts
    WHERE auth_uid=p_actor_uid AND role_code='hq' AND account_status='ACTIVE' FOR SHARE;
  IF actor_id IS NULL THEN RAISE EXCEPTION 'TEAM_ONLY_HQ' USING ERRCODE='42501'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('ACTIVE','ARCHIVED') THEN RAISE EXCEPTION 'TEAM_INVALID_STATE' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-team-membership-v91',0));
  SELECT t.staff_account_id,t.teacher_status INTO account_id,old_status
    FROM public.teachers t JOIN public.staff_accounts a ON a.id=t.staff_account_id AND a.role_code='teacher'
    WHERE t.id=p_teacher_id FOR UPDATE OF t,a;
  IF account_id IS NULL THEN RAISE EXCEPTION 'TEAM_TEACHER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_status='ARCHIVED' THEN
    IF EXISTS(SELECT 1 FROM public.teacher_team_leaders WHERE teacher_id=p_teacher_id AND enabled) THEN
      SELECT COUNT(*) INTO released_count FROM public.teacher_team_members WHERE leader_teacher_id=p_teacher_id;
      -- Remove bindings before disabling so the old revoke trigger has no
      -- members to audit. Archival creates no additional team event records.
      DELETE FROM public.teacher_team_members WHERE leader_teacher_id=p_teacher_id;
      UPDATE public.teacher_team_leaders SET enabled=FALSE,updated_by_account_id=actor_id WHERE teacher_id=p_teacher_id;
    END IF;
    DELETE FROM public.teacher_team_members WHERE member_teacher_id=p_teacher_id RETURNING leader_teacher_id INTO original_leader;
  END IF;
  UPDATE public.teachers SET teacher_status=p_status,updated_at=NOW() WHERE id=p_teacher_id;
  IF NOT EXISTS(SELECT 1 FROM public.staff_accounts WHERE id=account_id AND account_status=p_status) THEN
    RAISE EXCEPTION 'TEAM_STATUS_SYNC_FAILED' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('teacherId',p_teacher_id::text,'status',p_status,'releasedCount',released_count,
    'detachedFromGroup',original_leader IS NOT NULL,'idempotentReplay',old_status=p_status);
END; $$;

CREATE FUNCTION public.teacher_team_leader_name_v93(p_teacher_id BIGINT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE((SELECT leader.teacher_name FROM public.teacher_team_members m
    JOIN public.teachers member ON member.id=m.member_teacher_id AND member.teacher_status='ACTIVE'
    JOIN public.staff_accounts ma ON ma.id=member.staff_account_id AND ma.role_code='teacher' AND ma.account_status='ACTIVE'
    JOIN public.teacher_team_leaders l ON l.teacher_id=m.leader_teacher_id AND l.enabled
    JOIN public.teachers leader ON leader.id=l.teacher_id AND leader.teacher_status='ACTIVE'
    JOIN public.staff_accounts la ON la.id=leader.staff_account_id AND la.role_code='teacher' AND la.account_status='ACTIVE'
    WHERE m.member_teacher_id=p_teacher_id),'');
$$;
CREATE OR REPLACE FUNCTION public.can_read_teacher_team_member_v91(p_uid TEXT,p_teacher_id BIGINT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.staff_accounts a
    JOIN public.teachers leader ON leader.staff_account_id=a.id AND leader.teacher_status='ACTIVE'
    JOIN public.teacher_team_leaders l ON l.teacher_id=leader.id AND l.enabled
    JOIN public.teacher_team_members m ON m.leader_teacher_id=leader.id AND m.member_teacher_id=p_teacher_id
    JOIN public.teachers member ON member.id=m.member_teacher_id AND member.teacher_status='ACTIVE'
    JOIN public.staff_accounts ma ON ma.id=member.staff_account_id AND ma.role_code='teacher' AND ma.account_status='ACTIVE'
    WHERE a.auth_uid=p_uid AND a.role_code='teacher' AND a.account_status='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM public.teacher_team_leaders other WHERE other.teacher_id=member.id AND other.enabled));
$$;
REVOKE ALL ON FUNCTION public.lock_teacher_team_status_v93(),public.enforce_active_teacher_team_v93(),
 public.set_teacher_status_v93(TEXT,BIGINT,TEXT),public.teacher_team_leader_name_v93(BIGINT) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_teacher_status_v93(TEXT,BIGINT,TEXT),public.teacher_team_leader_name_v93(BIGINT) TO service_role;
COMMIT;

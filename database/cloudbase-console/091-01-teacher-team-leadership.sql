-- Teacher is still the business role. Only HQ appoints leaders and assigns
-- ordinary teachers. Revoking leadership atomically releases every member.
BEGIN;

CREATE TABLE public.teacher_team_leaders (
  teacher_id BIGINT PRIMARY KEY REFERENCES public.teachers(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  appointed_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id) ON DELETE RESTRICT,
  updated_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE TABLE public.teacher_team_members (
  member_teacher_id BIGINT PRIMARY KEY REFERENCES public.teachers(id) ON DELETE RESTRICT,
  leader_teacher_id BIGINT NOT NULL REFERENCES public.teacher_team_leaders(teacher_id) ON DELETE RESTRICT,
  assigned_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT teacher_team_not_self CHECK (member_teacher_id <> leader_teacher_id)
);
CREATE INDEX teacher_team_members_by_leader ON public.teacher_team_members(leader_teacher_id, member_teacher_id);

CREATE TABLE public.teacher_team_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('APPOINT', 'REVOKE', 'ADD', 'REMOVE', 'AUTO_RELEASE')),
  leader_teacher_id BIGINT NOT NULL REFERENCES public.teachers(id) ON DELETE RESTRICT,
  member_teacher_id BIGINT REFERENCES public.teachers(id) ON DELETE RESTRICT,
  actor_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id) ON DELETE RESTRICT,
  affected_member_count BIGINT NOT NULL DEFAULT 0 CHECK (affected_member_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);
CREATE INDEX teacher_team_events_by_leader ON public.teacher_team_events(leader_teacher_id, id DESC);

CREATE FUNCTION public.guard_teacher_team_leader_v91()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-team-membership-v91', 0));
  IF TG_OP = 'UPDATE' AND NEW.teacher_id IS DISTINCT FROM OLD.teacher_id THEN
    RAISE EXCEPTION 'TEAM_LEADER_ID_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.enabled THEN
    IF EXISTS (SELECT 1 FROM public.teacher_team_members WHERE member_teacher_id = NEW.teacher_id) THEN
      RAISE EXCEPTION 'TEAM_REMOVE_BEFORE_PROMOTION' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM public.teachers t JOIN public.staff_accounts a ON a.id = t.staff_account_id
      WHERE t.id = NEW.teacher_id AND t.teacher_status = 'ACTIVE'
        AND a.role_code = 'teacher' AND a.account_status = 'ACTIVE' FOR SHARE OF t, a;
    IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_TEACHER_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  END IF;
  PERFORM 1 FROM public.staff_accounts WHERE id = NEW.updated_by_account_id
    AND role_code = 'hq' AND account_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_ONLY_HQ' USING ERRCODE = '42501'; END IF;
  NEW.updated_at := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;
CREATE TRIGGER teacher_team_leader_guard BEFORE INSERT OR UPDATE ON public.teacher_team_leaders
  FOR EACH ROW EXECUTE FUNCTION public.guard_teacher_team_leader_v91();

CREATE FUNCTION public.guard_teacher_team_member_v91()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-team-membership-v91', 0));
  IF TG_OP = 'UPDATE' AND (NEW.member_teacher_id IS DISTINCT FROM OLD.member_teacher_id
      OR NEW.leader_teacher_id IS DISTINCT FROM OLD.leader_teacher_id) THEN
    RAISE EXCEPTION 'TEAM_REMOVE_BEFORE_TRANSFER' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.teacher_team_leaders l
    JOIN public.teachers t ON t.id = l.teacher_id
    JOIN public.staff_accounts a ON a.id = t.staff_account_id
    WHERE l.teacher_id = NEW.leader_teacher_id AND l.enabled
      AND t.teacher_status = 'ACTIVE' AND a.role_code = 'teacher' AND a.account_status = 'ACTIVE'
    FOR SHARE OF l, t, a;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_LEADER_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.teacher_team_leaders WHERE teacher_id = NEW.member_teacher_id AND enabled) THEN
    RAISE EXCEPTION 'TEAM_MEMBER_IS_LEADER' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.teachers t JOIN public.staff_accounts a ON a.id = t.staff_account_id
    WHERE t.id = NEW.member_teacher_id AND t.teacher_status = 'ACTIVE'
      AND a.role_code = 'teacher' AND a.account_status = 'ACTIVE' FOR SHARE OF t, a;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_TEACHER_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.staff_accounts WHERE id = NEW.assigned_by_account_id
    AND role_code = 'hq' AND account_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_ONLY_HQ' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER teacher_team_member_guard BEFORE INSERT OR UPDATE ON public.teacher_team_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_teacher_team_member_v91();

CREATE FUNCTION public.release_revoked_teacher_team_v91()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.enabled AND NOT NEW.enabled THEN
    WITH released AS (
      DELETE FROM public.teacher_team_members WHERE leader_teacher_id = NEW.teacher_id
      RETURNING member_teacher_id
    )
    INSERT INTO public.teacher_team_events(event_type, leader_teacher_id, member_teacher_id, actor_account_id)
      SELECT 'AUTO_RELEASE', NEW.teacher_id, member_teacher_id, NEW.updated_by_account_id FROM released;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER teacher_team_release_on_revoke AFTER UPDATE OF enabled ON public.teacher_team_leaders
  FOR EACH ROW EXECUTE FUNCTION public.release_revoked_teacher_team_v91();

CREATE FUNCTION public.protect_teacher_team_audit_v91()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'TEAM_AUDIT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER teacher_team_audit_immutable BEFORE UPDATE OR DELETE ON public.teacher_team_events
  FOR EACH ROW EXECUTE FUNCTION public.protect_teacher_team_audit_v91();

CREATE FUNCTION public.set_teacher_team_leader_v91(p_actor_uid TEXT, p_teacher_id BIGINT, p_enabled BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor_id BIGINT; was_enabled BOOLEAN; released_count BIGINT := 0;
BEGIN
  SELECT id INTO actor_id FROM public.staff_accounts WHERE auth_uid = p_actor_uid
    AND role_code = 'hq' AND account_status = 'ACTIVE' FOR SHARE;
  IF actor_id IS NULL THEN RAISE EXCEPTION 'TEAM_ONLY_HQ' USING ERRCODE = '42501'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'TEAM_INVALID_STATE' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-team-membership-v91', 0));
  PERFORM 1 FROM public.teachers t JOIN public.staff_accounts a ON a.id = t.staff_account_id
    WHERE t.id = p_teacher_id AND a.role_code = 'teacher' FOR UPDATE OF t, a;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_TEACHER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT enabled INTO was_enabled FROM public.teacher_team_leaders WHERE teacher_id = p_teacher_id FOR UPDATE;
  was_enabled := COALESCE(was_enabled, FALSE);
  IF was_enabled = p_enabled THEN
    RETURN jsonb_build_object('teacherId', p_teacher_id::text, 'isTeamLeader', p_enabled, 'releasedCount', 0, 'idempotentReplay', TRUE);
  END IF;
  IF p_enabled THEN
    INSERT INTO public.teacher_team_leaders(teacher_id, enabled, appointed_by_account_id, updated_by_account_id)
      VALUES (p_teacher_id, TRUE, actor_id, actor_id)
      ON CONFLICT (teacher_id) DO UPDATE SET enabled = TRUE,
        appointed_by_account_id = actor_id, updated_by_account_id = actor_id;
  ELSE
    SELECT COUNT(*) INTO released_count FROM public.teacher_team_members WHERE leader_teacher_id = p_teacher_id;
    UPDATE public.teacher_team_leaders SET enabled = FALSE, updated_by_account_id = actor_id WHERE teacher_id = p_teacher_id;
    IF EXISTS (SELECT 1 FROM public.teacher_team_members WHERE leader_teacher_id = p_teacher_id) THEN
      RAISE EXCEPTION 'TEAM_RELEASE_INCOMPLETE' USING ERRCODE = '23514';
    END IF;
  END IF;
  INSERT INTO public.teacher_team_events(event_type, leader_teacher_id, actor_account_id, affected_member_count)
    VALUES (CASE WHEN p_enabled THEN 'APPOINT' ELSE 'REVOKE' END, p_teacher_id, actor_id, released_count);
  RETURN jsonb_build_object('teacherId', p_teacher_id::text, 'isTeamLeader', p_enabled, 'releasedCount', released_count, 'idempotentReplay', FALSE);
END;
$$;

CREATE FUNCTION public.set_teacher_team_member_v91(p_actor_uid TEXT, p_leader_id BIGINT, p_member_id BIGINT, p_assigned BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor_id BIGINT; previous_leader_id BIGINT;
BEGIN
  SELECT id INTO actor_id FROM public.staff_accounts WHERE auth_uid = p_actor_uid
    AND role_code = 'hq' AND account_status = 'ACTIVE' FOR SHARE;
  IF actor_id IS NULL THEN RAISE EXCEPTION 'TEAM_ONLY_HQ' USING ERRCODE = '42501'; END IF;
  IF p_assigned IS NULL OR p_leader_id = p_member_id THEN
    RAISE EXCEPTION 'TEAM_INVALID_MEMBER' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-team-membership-v91', 0));
  PERFORM 1 FROM public.teacher_team_leaders WHERE teacher_id = p_leader_id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_LEADER_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  SELECT leader_teacher_id INTO previous_leader_id FROM public.teacher_team_members
    WHERE member_teacher_id = p_member_id FOR UPDATE;
  IF previous_leader_id IS NOT NULL AND previous_leader_id <> p_leader_id THEN
    RAISE EXCEPTION 'TEAM_REMOVE_BEFORE_TRANSFER' USING ERRCODE = '23514';
  END IF;
  IF (p_assigned AND previous_leader_id = p_leader_id) OR (NOT p_assigned AND previous_leader_id IS NULL) THEN
    RETURN jsonb_build_object('memberTeacherId', p_member_id::text, 'leaderTeacherId', p_leader_id::text, 'assigned', p_assigned, 'idempotentReplay', TRUE);
  END IF;
  IF p_assigned THEN
    INSERT INTO public.teacher_team_members(member_teacher_id, leader_teacher_id, assigned_by_account_id)
      VALUES (p_member_id, p_leader_id, actor_id);
  ELSE
    DELETE FROM public.teacher_team_members WHERE member_teacher_id = p_member_id AND leader_teacher_id = p_leader_id;
  END IF;
  INSERT INTO public.teacher_team_events(event_type, leader_teacher_id, member_teacher_id, actor_account_id)
    VALUES (CASE WHEN p_assigned THEN 'ADD' ELSE 'REMOVE' END, p_leader_id, p_member_id, actor_id);
  RETURN jsonb_build_object('memberTeacherId', p_member_id::text, 'leaderTeacherId', p_leader_id::text, 'assigned', p_assigned, 'idempotentReplay', FALSE);
END;
$$;

CREATE FUNCTION public.is_teacher_team_leader_v91(p_uid TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.staff_accounts a
    JOIN public.teachers t ON t.staff_account_id = a.id
    JOIN public.teacher_team_leaders l ON l.teacher_id = t.id AND l.enabled
    WHERE a.auth_uid = p_uid AND a.role_code = 'teacher' AND a.account_status = 'ACTIVE' AND t.teacher_status = 'ACTIVE');
$$;

CREATE FUNCTION public.can_read_teacher_team_member_v91(p_uid TEXT, p_teacher_id BIGINT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.staff_accounts a
    JOIN public.teachers leader ON leader.staff_account_id = a.id
    JOIN public.teacher_team_leaders l ON l.teacher_id = leader.id AND l.enabled
    JOIN public.teacher_team_members m ON m.leader_teacher_id = leader.id AND m.member_teacher_id = p_teacher_id
    JOIN public.teachers member ON member.id = m.member_teacher_id
    JOIN public.staff_accounts member_account ON member_account.id = member.staff_account_id AND member_account.role_code = 'teacher'
    WHERE a.auth_uid = p_uid AND a.role_code = 'teacher' AND a.account_status = 'ACTIVE' AND leader.teacher_status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM public.teacher_team_leaders other WHERE other.teacher_id = member.id AND other.enabled));
$$;

REVOKE ALL ON TABLE public.teacher_team_leaders, public.teacher_team_members, public.teacher_team_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.teacher_team_leaders, public.teacher_team_members, public.teacher_team_events TO service_role;
REVOKE ALL ON SEQUENCE public.teacher_team_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_teacher_team_leader_v91(), public.guard_teacher_team_member_v91(),
  public.release_revoked_teacher_team_v91(), public.protect_teacher_team_audit_v91(),
  public.set_teacher_team_leader_v91(TEXT, BIGINT, BOOLEAN), public.set_teacher_team_member_v91(TEXT, BIGINT, BIGINT, BOOLEAN),
  public.is_teacher_team_leader_v91(TEXT), public.can_read_teacher_team_member_v91(TEXT, BIGINT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_teacher_team_leader_v91(TEXT, BIGINT, BOOLEAN),
  public.set_teacher_team_member_v91(TEXT, BIGINT, BIGINT, BOOLEAN),
  public.is_teacher_team_leader_v91(TEXT), public.can_read_teacher_team_member_v91(TEXT, BIGINT) TO service_role;

COMMIT;

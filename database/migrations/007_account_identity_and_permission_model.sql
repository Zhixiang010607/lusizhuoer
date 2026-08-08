-- Separate login accounts from business identities and permissions.
-- Run after migration 006.  All SQL text is ASCII-only.

BEGIN;

-- staff_accounts remains the only login-account table.  Password, phone, and
-- auth_uid belong there.  Business records never point to a phone number.
CREATE TABLE IF NOT EXISTS public.access_roles (
  role_code VARCHAR(16) PRIMARY KEY,
  role_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (role_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_code VARCHAR(16) NOT NULL REFERENCES public.access_roles(role_code),
  permission_code VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS public.account_role_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
  role_code VARCHAR(16) NOT NULL REFERENCES public.access_roles(role_code),
  grant_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (grant_status IN ('ACTIVE', 'ARCHIVED')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by BIGINT REFERENCES public.staff_accounts(id),
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_role_per_account
  ON public.account_role_assignments (account_id)
  WHERE grant_status = 'ACTIVE';

-- Headquarters and operation employees have their own business identity
-- records, just as teachers and stores already do.
CREATE TABLE IF NOT EXISTS public.hq_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_account_id BIGINT NOT NULL UNIQUE REFERENCES public.staff_accounts(id),
  profile_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (profile_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.operation_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_account_id BIGINT NOT NULL UNIQUE REFERENCES public.staff_accounts(id),
  profile_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (profile_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly one active identity is bound to one account.  subject_id is the
-- primary key in its own entity table: hq_profiles, operation_profiles,
-- teachers, or stores.
CREATE TABLE IF NOT EXISTS public.account_identity_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
  subject_type VARCHAR(16) NOT NULL
    CHECK (subject_type IN ('hq', 'operation', 'teacher', 'store')),
  subject_id BIGINT NOT NULL,
  link_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (link_status IN ('ACTIVE', 'ARCHIVED')),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by BIGINT REFERENCES public.staff_accounts(id),
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_identity_per_account
  ON public.account_identity_links (account_id)
  WHERE link_status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_account_per_subject
  ON public.account_identity_links (subject_type, subject_id)
  WHERE link_status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_account_identity_subject
  ON public.account_identity_links (subject_type, subject_id, link_status);

INSERT INTO public.access_roles (role_code)
VALUES ('hq'), ('operation'), ('store'), ('teacher')
ON CONFLICT (role_code) DO NOTHING;

INSERT INTO public.role_permissions (role_code, permission_code)
VALUES
  ('hq', 'global.read.all'),
  ('hq', 'master.write.all'),
  ('hq', 'account.manage'),
  ('hq', 'review.approve'),
  ('operation', 'global.read.assigned_store'),
  ('operation', 'record.read.assigned_store'),
  ('store', 'global.read.own_store'),
  ('store', 'record.write.own_store'),
  ('teacher', 'global.read.own'),
  ('teacher', 'record.write.own'),
  ('teacher', 'review.request.own')
ON CONFLICT (role_code, permission_code) DO NOTHING;

-- Keep the new account-role table synchronized with the existing role_code
-- used by the deployed staffAccount function.
CREATE OR REPLACE FUNCTION public.sync_account_role_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.account_role_assignments
  SET grant_status = 'ARCHIVED', archived_at = NOW()
  WHERE account_id = NEW.id
    AND grant_status = 'ACTIVE'
    AND role_code IS DISTINCT FROM NEW.role_code;

  INSERT INTO public.account_role_assignments (account_id, role_code, grant_status)
  SELECT NEW.id, NEW.role_code,
    CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.account_role_assignments r
    WHERE r.account_id = NEW.id
      AND r.role_code = NEW.role_code
      AND r.grant_status = CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
  );

  UPDATE public.account_role_assignments
  SET grant_status = CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END,
      archived_at = CASE WHEN NEW.account_status = 'ACTIVE' THEN NULL ELSE NOW() END
  WHERE account_id = NEW.id
    AND role_code = NEW.role_code
    AND grant_status IS DISTINCT FROM CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;

  UPDATE public.account_identity_links
  SET link_status = CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END,
      archived_at = CASE WHEN NEW.account_status = 'ACTIVE' THEN NULL ELSE NOW() END
  WHERE account_id = NEW.id
    AND link_status IS DISTINCT FROM CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_account_role_assignment ON public.staff_accounts;
CREATE TRIGGER trg_sync_account_role_assignment
AFTER INSERT OR UPDATE OF role_code, account_status ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.sync_account_role_assignment();

CREATE OR REPLACE FUNCTION public.sync_hq_or_operation_identity_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_type VARCHAR(16);
BEGIN
  target_type := TG_ARGV[0];
  IF NEW.profile_status = 'ACTIVE' THEN
    UPDATE public.account_identity_links
    SET link_status = 'ARCHIVED', archived_at = NOW()
    WHERE account_id = NEW.staff_account_id
      AND link_status = 'ACTIVE'
      AND (subject_type <> target_type OR subject_id <> NEW.id);
    IF NOT EXISTS (
      SELECT 1 FROM public.account_identity_links
      WHERE account_id = NEW.staff_account_id
        AND subject_type = target_type
        AND subject_id = NEW.id
        AND link_status = 'ACTIVE'
    ) THEN
      INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status)
      VALUES (NEW.staff_account_id, target_type, NEW.id, 'ACTIVE');
    END IF;
  ELSE
    UPDATE public.account_identity_links
    SET link_status = 'ARCHIVED', archived_at = NOW()
    WHERE account_id = NEW.staff_account_id
      AND subject_type = target_type
      AND subject_id = NEW.id
      AND link_status = 'ACTIVE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_staff_profile_for_role()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role_code = 'hq' THEN
    INSERT INTO public.hq_profiles (staff_account_id, profile_status)
    VALUES (NEW.id, NEW.account_status)
    ON CONFLICT (staff_account_id) DO NOTHING;
  ELSIF NEW.role_code = 'operation' THEN
    INSERT INTO public.operation_profiles (staff_account_id, profile_status)
    VALUES (NEW.id, NEW.account_status)
    ON CONFLICT (staff_account_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_staff_profile_for_role ON public.staff_accounts;
CREATE TRIGGER trg_create_staff_profile_for_role
AFTER INSERT ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.create_staff_profile_for_role();

DROP TRIGGER IF EXISTS trg_hq_identity_link ON public.hq_profiles;
CREATE TRIGGER trg_hq_identity_link
AFTER INSERT OR UPDATE OF staff_account_id, profile_status ON public.hq_profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_hq_or_operation_identity_link('hq');

DROP TRIGGER IF EXISTS trg_operation_identity_link ON public.operation_profiles;
CREATE TRIGGER trg_operation_identity_link
AFTER INSERT OR UPDATE OF staff_account_id, profile_status ON public.operation_profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_hq_or_operation_identity_link('operation');

CREATE OR REPLACE FUNCTION public.sync_teacher_identity_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.staff_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.teacher_status = 'ACTIVE' THEN
    UPDATE public.account_identity_links
    SET link_status = 'ARCHIVED', archived_at = NOW()
    WHERE account_id = NEW.staff_account_id
      AND link_status = 'ACTIVE'
      AND (subject_type <> 'teacher' OR subject_id <> NEW.id);
    IF NOT EXISTS (
      SELECT 1 FROM public.account_identity_links
      WHERE account_id = NEW.staff_account_id
        AND subject_type = 'teacher'
        AND subject_id = NEW.id
        AND link_status = 'ACTIVE'
    ) THEN
      INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status)
      VALUES (NEW.staff_account_id, 'teacher', NEW.id, 'ACTIVE');
    END IF;
  ELSE
    UPDATE public.account_identity_links
    SET link_status = 'ARCHIVED', archived_at = NOW()
    WHERE account_id = NEW.staff_account_id
      AND subject_type = 'teacher'
      AND subject_id = NEW.id
      AND link_status = 'ACTIVE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_teacher_identity_link ON public.teachers;
CREATE TRIGGER trg_teacher_identity_link
AFTER INSERT OR UPDATE OF staff_account_id, teacher_status ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_identity_link();

CREATE OR REPLACE FUNCTION public.sync_store_identity_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assignment_status = 'ACTIVE' THEN
    UPDATE public.account_identity_links
    SET link_status = 'ARCHIVED', archived_at = NOW()
    WHERE account_id = NEW.staff_account_id
      AND link_status = 'ACTIVE'
      AND (subject_type <> 'store' OR subject_id <> NEW.store_id);
    IF NOT EXISTS (
      SELECT 1 FROM public.account_identity_links
      WHERE account_id = NEW.staff_account_id
        AND subject_type = 'store'
        AND subject_id = NEW.store_id
        AND link_status = 'ACTIVE'
    ) THEN
      INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status)
      VALUES (NEW.staff_account_id, 'store', NEW.store_id, 'ACTIVE');
    END IF;
  ELSE
    UPDATE public.account_identity_links
    SET link_status = 'ARCHIVED', archived_at = NOW()
    WHERE account_id = NEW.staff_account_id
      AND subject_type = 'store'
      AND subject_id = NEW.store_id
      AND link_status = 'ACTIVE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_store_identity_link ON public.staff_store_assignments;
CREATE TRIGGER trg_store_identity_link
AFTER INSERT OR UPDATE OF staff_account_id, store_id, assignment_status ON public.staff_store_assignments
FOR EACH ROW EXECUTE FUNCTION public.sync_store_identity_link();

-- Backfill profiles, permissions, and links for accounts already in use.
INSERT INTO public.hq_profiles (staff_account_id, profile_status)
SELECT id, account_status
FROM public.staff_accounts
WHERE role_code = 'hq'
ON CONFLICT (staff_account_id) DO NOTHING;

INSERT INTO public.operation_profiles (staff_account_id, profile_status)
SELECT id, account_status
FROM public.staff_accounts
WHERE role_code = 'operation'
ON CONFLICT (staff_account_id) DO NOTHING;

INSERT INTO public.account_role_assignments (account_id, role_code, grant_status)
SELECT id, role_code, CASE WHEN account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
FROM public.staff_accounts
ON CONFLICT DO NOTHING;

INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status)
SELECT p.staff_account_id, 'hq', p.id,
  CASE WHEN p.profile_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
FROM public.hq_profiles p
ON CONFLICT DO NOTHING;

INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status)
SELECT p.staff_account_id, 'operation', p.id,
  CASE WHEN p.profile_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
FROM public.operation_profiles p
ON CONFLICT DO NOTHING;

INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status)
SELECT t.staff_account_id, 'teacher', t.id,
  CASE WHEN t.teacher_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
FROM public.teachers t
WHERE t.staff_account_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status)
SELECT a.staff_account_id, 'store', a.store_id,
  CASE WHEN a.assignment_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
FROM public.staff_store_assignments a
ON CONFLICT DO NOTHING;

ALTER TABLE public.access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hq_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_identity_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_identity_self_or_hq_read ON public.account_identity_links;
CREATE POLICY account_identity_self_or_hq_read
ON public.account_identity_links
FOR SELECT TO authenticated
USING (
  account_id = public.current_staff_account_id()
  OR public.current_staff_role() = 'hq'
);

DROP POLICY IF EXISTS account_roles_self_or_hq_read ON public.account_role_assignments;
CREATE POLICY account_roles_self_or_hq_read
ON public.account_role_assignments
FOR SELECT TO authenticated
USING (
  account_id = public.current_staff_account_id()
  OR public.current_staff_role() = 'hq'
);

DROP POLICY IF EXISTS access_roles_authenticated_read ON public.access_roles;
CREATE POLICY access_roles_authenticated_read
ON public.access_roles
FOR SELECT TO authenticated
USING (TRUE);

DROP POLICY IF EXISTS role_permissions_self_or_hq_read ON public.role_permissions;
CREATE POLICY role_permissions_self_or_hq_read
ON public.role_permissions
FOR SELECT TO authenticated
USING (
  role_code IN (
    SELECT role_code
    FROM public.account_role_assignments
    WHERE account_id = public.current_staff_account_id()
      AND grant_status = 'ACTIVE'
  )
  OR public.current_staff_role() = 'hq'
);

CREATE OR REPLACE VIEW public.v_account_access AS
SELECT
  a.id AS account_id,
  a.auth_uid,
  a.phone,
  a.staff_name,
  a.account_status,
  l.subject_type,
  l.subject_id,
  r.role_code,
  ARRAY_AGG(p.permission_code ORDER BY p.permission_code)
    FILTER (WHERE p.permission_code IS NOT NULL) AS permissions
FROM public.staff_accounts a
LEFT JOIN public.account_identity_links l
  ON l.account_id = a.id AND l.link_status = 'ACTIVE'
LEFT JOIN public.account_role_assignments r
  ON r.account_id = a.id AND r.grant_status = 'ACTIVE'
LEFT JOIN public.role_permissions p ON p.role_code = r.role_code
GROUP BY a.id, a.auth_uid, a.phone, a.staff_name, a.account_status,
  l.subject_type, l.subject_id, r.role_code;

COMMIT;

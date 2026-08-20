-- Repair legacy teacher-account/profile gaps and remove the remaining
-- PL/pgSQL output-column ambiguities from teacher experience quota actions.
--
-- Existing teacher activation and archive state is independent of whether a
-- face has already been enrolled.  New teacher creation still requires a face
-- at the service boundary.  This forward migration backfills any stress/legacy
-- staff account that missed its teacher master row and keeps future writes in
-- sync.  It does not rewrite historical face, quota, recharge, reset or usage
-- ledgers.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGCLASS('public.teachers') IS NULL
     OR TO_REGCLASS('public.teacher_product_experience_quotas') IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_recharges') IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_configuration_events') IS NULL
     OR TO_REGPROCEDURE('public.assert_active_teacher_experience_subjects(bigint,bigint)') IS NULL
     OR TO_REGPROCEDURE('public.assert_teacher_experience_quota_actor(bigint)') IS NULL
     OR TO_REGPROCEDURE('public.validate_teacher_experience_quota_recharge(integer,text,character varying)') IS NULL
     OR TO_REGPROCEDURE('public.reset_teacher_experience_quota(bigint,date,bigint)') IS NULL THEN
    RAISE EXCEPTION 'teacher profile/quota prerequisites are missing; execute migrations through 049 first';
  END IF;
END;
$$;

LOCK TABLE public.staff_accounts, public.teachers,
           public.teacher_product_experience_quotas,
           public.teacher_experience_quota_recharges
  IN SHARE ROW EXCLUSIVE MODE;

-- Face state never participates in account/profile activation.  The trigger
-- also creates a missing teacher master row before later status operations can
-- touch the external authentication account.
CREATE OR REPLACE FUNCTION public.sync_teacher_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  desired_status TEXT;
BEGIN
  IF NEW.role_code <> 'teacher' THEN
    RETURN NEW;
  END IF;
  desired_status := CASE WHEN NEW.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;
  INSERT INTO public.teachers
    (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
  VALUES
    ('TCHF' || NEW.id::TEXT, NEW.staff_name, NEW.id, desired_status, 'PENDING')
  ON CONFLICT (staff_account_id) DO UPDATE
    SET teacher_name = EXCLUDED.teacher_name,
        teacher_status = EXCLUDED.teacher_status,
        updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_teacher_account_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  desired_status TEXT;
BEGIN
  IF NEW.staff_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  desired_status := CASE WHEN NEW.teacher_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END;
  UPDATE public.staff_accounts AS account
     SET account_status = desired_status,
         updated_at = NOW()
   WHERE account.id = NEW.staff_account_id
     AND account.account_status IS DISTINCT FROM desired_status;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_teacher_profile ON public.staff_accounts;
CREATE TRIGGER trg_sync_teacher_profile
AFTER INSERT OR UPDATE OF staff_name, account_status, role_code ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_profile();

DROP TRIGGER IF EXISTS trg_sync_teacher_account_status ON public.teachers;
CREATE TRIGGER trg_sync_teacher_account_status
AFTER INSERT OR UPDATE OF teacher_status, staff_account_id ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_account_status();

-- One idempotent statement repairs both a missing row and a stale name/status.
-- PENDING is only an initial face attribute; it does not archive an account.
INSERT INTO public.teachers
  (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
SELECT 'TCHF' || account.id::TEXT,
       account.staff_name,
       account.id,
       CASE WHEN account.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END,
       'PENDING'
  FROM public.staff_accounts AS account
 WHERE account.role_code = 'teacher'
ON CONFLICT (staff_account_id) DO UPDATE
  SET teacher_name = EXCLUDED.teacher_name,
      teacher_status = EXCLUDED.teacher_status,
      updated_at = NOW();

-- Removing a live configuration is a current business action, so the same
-- active teacher/product gate used by configure and recharge must apply even
-- when an old browser calls the function directly.
CREATE OR REPLACE FUNCTION public.delete_teacher_product_experience_quota(
  p_teacher_id BIGINT,
  p_product_id BIGINT,
  p_actor_account_id BIGINT
)
RETURNS TABLE(
  quota_id BIGINT,
  teacher_id BIGINT,
  product_id BIGINT,
  available_count INTEGER,
  removed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  quota_row public.teacher_product_experience_quotas%ROWTYPE;
  removed_at_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM public.assert_active_teacher_experience_subjects(p_teacher_id, p_product_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));
  SELECT quota.* INTO quota_row
    FROM public.teacher_product_experience_quotas AS quota
   WHERE quota.teacher_id = p_teacher_id
     AND quota.product_id = p_product_id
     AND quota.quota_status = 'ACTIVE'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no active experience quota for this product' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.teacher_product_experience_quotas AS quota_target
     SET quota_status = 'ARCHIVED',
         archived_at = removed_at_value,
         archived_by_account_id = p_actor_account_id,
         updated_by_account_id = p_actor_account_id,
         updated_at = removed_at_value
   WHERE quota_target.id = quota_row.id
   RETURNING quota_target.* INTO quota_row;
  INSERT INTO public.teacher_experience_quota_configuration_events
    (quota_id, teacher_id, product_id, event_type, monthly_allowance, quota_month,
     available_before_count, available_after_count, occurred_by_account_id, occurred_at)
  VALUES
    (quota_row.id, quota_row.teacher_id, quota_row.product_id, 'REMOVED',
     quota_row.monthly_allowance, quota_row.quota_month, quota_row.available_count,
     quota_row.available_count, p_actor_account_id, removed_at_value);
  RETURN QUERY SELECT quota_row.id, quota_row.teacher_id, quota_row.product_id,
                      quota_row.available_count, removed_at_value;
END;
$$;

-- Every potentially ambiguous table/output name is qualified.  In particular,
-- available_count and manual_recharge_count are also RETURNS TABLE columns, so
-- an unqualified right-hand side raises SQLSTATE 42702 at runtime.

CREATE OR REPLACE FUNCTION public.recharge_teacher_product_experience_quota(
 p_teacher_id BIGINT,p_product_id BIGINT,p_unit_count INTEGER,p_note TEXT,p_idempotency_key VARCHAR,p_actor_account_id BIGINT)
RETURNS TABLE(recharge_id BIGINT,created_now BOOLEAN,quota_id BIGINT,quota_month DATE,available_before_count INTEGER,
 available_after_count INTEGER,monthly_allowance INTEGER,used_count INTEGER,manual_recharge_count INTEGER,created_at TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE
 q public.teacher_product_experience_quotas%ROWTYPE;
 r public.teacher_experience_quota_recharges%ROWTYPE;
 m DATE:=public.teacher_experience_quota_month(); n TEXT; b INTEGER;
BEGIN
 n:=public.validate_teacher_experience_quota_recharge(p_unit_count,p_note,p_idempotency_key);
 PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
 PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-recharge:'||p_idempotency_key));
 PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:'||p_teacher_id::TEXT||':'||p_product_id::TEXT));
 SELECT recharge.* INTO r FROM public.teacher_experience_quota_recharges AS recharge
  WHERE recharge.idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF r.teacher_id<>p_teacher_id OR r.product_id<>p_product_id OR r.unit_count<>p_unit_count
   OR r.note<>n OR r.recharged_by_account_id<>p_actor_account_id THEN
   RAISE EXCEPTION 'idempotency key belongs to a different teacher experience recharge' USING ERRCODE='23505';
  END IF;
  SELECT quota.* INTO q FROM public.teacher_product_experience_quotas AS quota WHERE quota.id=r.quota_id;
  RETURN QUERY SELECT r.id,FALSE,r.quota_id,r.quota_month,r.available_before_count,r.available_after_count,
   q.monthly_allowance,q.used_count,q.manual_recharge_count,r.created_at; RETURN;
 END IF;
 PERFORM public.assert_active_teacher_experience_subjects(p_teacher_id,p_product_id);
 SELECT quota.* INTO q FROM public.teacher_product_experience_quotas AS quota
  WHERE quota.teacher_id=p_teacher_id AND quota.product_id=p_product_id
   AND quota.quota_status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'teacher has no active configured experience quota for this product' USING ERRCODE='23514'; END IF;
 q:=public.reset_teacher_experience_quota(q.id,m,p_actor_account_id);
 IF q.quota_status<>'ACTIVE' THEN RAISE EXCEPTION 'teacher has no active configured experience quota for this product' USING ERRCODE='23514'; END IF;
 b:=q.available_count;
 UPDATE public.teacher_product_experience_quotas AS quota_target
  SET available_count=quota_target.available_count+p_unit_count,
      manual_recharge_count=quota_target.manual_recharge_count+p_unit_count,
      updated_by_account_id=p_actor_account_id,updated_at=CLOCK_TIMESTAMP()
  WHERE quota_target.id=q.id AND quota_target.quota_status='ACTIVE' RETURNING quota_target.* INTO q;
 INSERT INTO public.teacher_experience_quota_recharges AS recharge_target
  (quota_id,teacher_id,product_id,quota_month,unit_count,available_before_count,
   available_after_count,note,idempotency_key,recharged_by_account_id)
 VALUES(q.id,p_teacher_id,p_product_id,q.quota_month,p_unit_count,b,q.available_count,n,p_idempotency_key,p_actor_account_id)
 RETURNING recharge_target.* INTO r;
 RETURN QUERY SELECT r.id,TRUE,q.id,q.quota_month,b,q.available_count,q.monthly_allowance,q.used_count,q.manual_recharge_count,r.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_teacher_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_teacher_account_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_teacher_product_experience_quota(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recharge_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, TEXT, VARCHAR, BIGINT) FROM PUBLIC;

COMMENT ON FUNCTION public.sync_teacher_profile() IS
  'Migration 050: every teacher staff account owns a same-status teacher master row; existing account status is face-independent.';
COMMENT ON FUNCTION public.delete_teacher_product_experience_quota(BIGINT, BIGINT, BIGINT) IS
  'Migration 050: removes only an active teacher/product entitlement and preserves all immutable history.';
COMMENT ON FUNCTION public.recharge_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, TEXT, VARCHAR, BIGINT) IS
  'Migration 050: idempotent active-entitlement top-up with output-column-safe qualified references.';

COMMIT;

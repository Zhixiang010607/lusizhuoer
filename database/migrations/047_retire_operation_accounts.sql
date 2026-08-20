-- Retire the operation role without deleting historic auditors or records.
-- Run after 046_teacher_face_and_experience_quotas.sql.
-- All SQL text is ASCII-only.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.staff_accounts') IS NULL
     OR to_regclass('public.recharge_records') IS NULL
     OR to_regclass('public.verification_records') IS NULL
     OR to_regprocedure('public.review_order_application(character varying,bigint,bigint,character varying,text)') IS NULL THEN
    RAISE EXCEPTION
      'operation retirement core prerequisites are missing; execute migrations through 046 first';
  END IF;
END;
$$;

-- Current installations can predate the optional operation-profile/role
-- tables. Those tables are archived when present; only the account and review
-- records are core prerequisites. Historic staff IDs always remain in place.
LOCK TABLE public.staff_accounts IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.reject_retired_operation_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.role_code = 'operation' THEN
    RAISE EXCEPTION 'operation accounts are retired' USING ERRCODE = '42501';
  END IF;

  IF NEW.role_code = 'operation' THEN
    IF TG_OP = 'UPDATE'
       AND OLD.role_code = 'operation'
       AND NEW.account_status = 'ARCHIVED' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'operation accounts may only remain archived historic rows'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.role_code = 'operation' THEN
    RAISE EXCEPTION 'historic operation accounts cannot be repurposed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_retired_operation_account ON public.staff_accounts;
CREATE TRIGGER trg_reject_retired_operation_account
BEFORE INSERT OR UPDATE OF role_code, account_status ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.reject_retired_operation_account();

CREATE OR REPLACE FUNCTION public.reject_active_operation_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.profile_status <> 'ARCHIVED' THEN
    RAISE EXCEPTION 'operation profiles are retained only as archived history'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.operation_profiles') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_reject_active_operation_profile ON public.operation_profiles';
    EXECUTE 'CREATE TRIGGER trg_reject_active_operation_profile
      BEFORE INSERT OR UPDATE OF profile_status ON public.operation_profiles
      FOR EACH ROW EXECUTE FUNCTION public.reject_active_operation_profile()';
  END IF;
END;
$$;

UPDATE public.staff_accounts
   SET account_status = 'ARCHIVED', updated_at = NOW()
 WHERE role_code = 'operation'
   AND account_status IS DISTINCT FROM 'ARCHIVED';

DO $$
BEGIN
  IF to_regclass('public.operation_profiles') IS NOT NULL THEN
    EXECUTE 'UPDATE public.operation_profiles
                SET profile_status = ''ARCHIVED'', updated_at = NOW()
              WHERE profile_status IS DISTINCT FROM ''ARCHIVED''';
  END IF;
  IF to_regclass('public.account_role_assignments') IS NOT NULL THEN
    EXECUTE 'UPDATE public.account_role_assignments
                SET grant_status = ''ARCHIVED'', archived_at = COALESCE(archived_at, NOW())
              WHERE role_code = ''operation''
                AND grant_status IS DISTINCT FROM ''ARCHIVED''';
  END IF;
  IF to_regclass('public.account_identity_links') IS NOT NULL THEN
    EXECUTE 'UPDATE public.account_identity_links
                SET link_status = ''ARCHIVED'', archived_at = COALESCE(archived_at, NOW())
              WHERE subject_type = ''operation''
                AND link_status IS DISTINCT FROM ''ARCHIVED''';
  END IF;
  IF to_regclass('public.operation_store_scopes') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'operation_store_scopes'
         AND column_name = 'archived_at'
    ) THEN
      EXECUTE 'UPDATE public.operation_store_scopes
                  SET scope_status = ''ARCHIVED'',
                      archived_at = COALESCE(archived_at, NOW())
                WHERE scope_status IS DISTINCT FROM ''ARCHIVED''';
    ELSE
      EXECUTE 'UPDATE public.operation_store_scopes
                  SET scope_status = ''ARCHIVED'', updated_at = NOW()
                WHERE scope_status IS DISTINCT FROM ''ARCHIVED''';
    END IF;
  END IF;
  IF to_regclass('public.access_roles') IS NOT NULL THEN
    EXECUTE 'UPDATE public.access_roles
                SET role_status = ''ARCHIVED''
              WHERE role_code = ''operation''
                AND role_status IS DISTINCT FROM ''ARCHIVED''';
  END IF;
  IF to_regclass('public.role_permissions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.role_permissions WHERE role_code = ''operation''';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_order_application(
  p_record_type VARCHAR,
  p_record_id BIGINT,
  p_actor_account_id BIGINT,
  p_decision VARCHAR,
  p_note TEXT
)
RETURNS TABLE(record_id BIGINT, record_code TEXT, record_status TEXT,
              void_request_status TEXT, reviewed_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  actor_role TEXT;
  decision TEXT := UPPER(COALESCE(p_decision, ''));
  current_status TEXT;
  current_void_status TEXT;
  current_code TEXT;
  current_type TEXT;
  recharge_customer_id BIGINT;
  recharge_product_id BIGINT;
  recharge_units INTEGER;
  refundable_units BIGINT;
  current_remaining BIGINT;
BEGIN
  SELECT a.role_code INTO actor_role FROM public.staff_accounts a
   WHERE a.id = p_actor_account_id AND a.account_status = 'ACTIVE';
  IF actor_role IS DISTINCT FROM 'hq' THEN
    RAISE EXCEPTION 'only headquarters can review orders' USING ERRCODE = '42501';
  END IF;
  IF decision NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'decision must be APPROVED or REJECTED' USING ERRCODE = '22023';
  END IF;
  IF LENGTH(COALESCE(p_note, '')) > 1000 THEN
    RAISE EXCEPTION 'review note is too long' USING ERRCODE = '22001';
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' THEN
    SELECT r.record_status, r.void_request_status, r.recharge_code, r.recharge_type,
           r.customer_id, r.product_id, r.unit_count
      INTO current_status, current_void_status, current_code, current_type,
           recharge_customer_id, recharge_product_id, recharge_units
      FROM public.recharge_records r WHERE r.id = p_record_id FOR UPDATE;
  ELSIF UPPER(p_record_type) = 'VERIFICATION' THEN
    SELECT v.record_status, v.void_request_status, v.verification_code
      INTO current_status, current_void_status, current_code
      FROM public.verification_records v WHERE v.id = p_record_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'unsupported record type' USING ERRCODE = '22023';
  END IF;
  IF current_code IS NULL THEN RAISE EXCEPTION 'order does not exist' USING ERRCODE = 'P0002'; END IF;
  IF current_void_status <> 'NONE' OR current_status <> 'PENDING' THEN
    RAISE EXCEPTION 'this application is no longer pending' USING ERRCODE = '23514';
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' AND current_type = 'REFUND' AND decision = 'APPROVED' THEN
    PERFORM 1 FROM public.customers c WHERE c.id = recharge_customer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'customer does not exist' USING ERRCODE = 'P0002'; END IF;

    SELECT COALESCE(SUM(CASE WHEN r.recharge_type = 'NEW' THEN r.unit_count ELSE -r.unit_count END), 0)
      INTO refundable_units
      FROM public.recharge_records r
     WHERE r.customer_id = recharge_customer_id
       AND r.product_id = recharge_product_id
       AND r.record_status = 'APPROVED';
    IF recharge_units > refundable_units THEN
      RAISE EXCEPTION 'refund units exceed unrefunded purchased units' USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(b.remaining_count, 0) INTO current_remaining
      FROM public.customer_product_balances b
     WHERE b.customer_id = recharge_customer_id AND b.product_id = recharge_product_id;
    current_remaining := COALESCE(current_remaining, 0);
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' THEN
    UPDATE public.recharge_records r
       SET record_status = decision,
           reviewed_by_account_id = p_actor_account_id,
           reviewed_at = NOW(),
           review_note = BTRIM(COALESCE(p_note, '')),
           balance_after_count = CASE
             WHEN current_type = 'REFUND' AND decision = 'APPROVED'
               THEN GREATEST(current_remaining - recharge_units, 0)::INTEGER
             ELSE r.balance_after_count
           END,
           updated_at = NOW()
     WHERE r.id = p_record_id;
  ELSE
    UPDATE public.verification_records v
       SET record_status = decision,
           reviewed_by_account_id = p_actor_account_id,
           reviewed_at = NOW(),
           review_note = BTRIM(COALESCE(p_note, '')),
           updated_at = NOW()
     WHERE v.id = p_record_id;
  END IF;

  RETURN QUERY SELECT p_record_id, current_code, decision, current_void_status, NOW();
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_hq_order_reviewer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reviewer_role TEXT;
BEGIN
  IF NEW.reviewed_by_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT role_code INTO reviewer_role
    FROM public.staff_accounts
   WHERE id = NEW.reviewed_by_account_id
     AND account_status = 'ACTIVE';
  IF reviewer_role IS DISTINCT FROM 'hq' THEN
    RAISE EXCEPTION 'only active headquarters accounts may review orders'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_hq_recharge_reviewer ON public.recharge_records;
CREATE TRIGGER trg_enforce_hq_recharge_reviewer
BEFORE INSERT OR UPDATE OF reviewed_by_account_id ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_hq_order_reviewer();

DROP TRIGGER IF EXISTS trg_enforce_hq_verification_reviewer ON public.verification_records;
CREATE TRIGGER trg_enforce_hq_verification_reviewer
BEFORE INSERT OR UPDATE OF reviewed_by_account_id ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_hq_order_reviewer();

REVOKE ALL ON FUNCTION public.reject_retired_operation_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_active_operation_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_order_application(VARCHAR, BIGINT, BIGINT, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_hq_order_reviewer() FROM PUBLIC;

COMMENT ON FUNCTION public.reject_retired_operation_account() IS
  'Migration 047: operation accounts remain archived historic rows only.';
COMMENT ON FUNCTION public.review_order_application(VARCHAR, BIGINT, BIGINT, VARCHAR, TEXT) IS
  'Migration 047: only active headquarters accounts may review orders.';

COMMIT;

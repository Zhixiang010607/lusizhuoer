-- Migration 079: restore store/teacher supplemental verification submissions.
-- Supplemental records are created PENDING without face/photo/BLE evidence,
-- then headquarters approval atomically rechecks and consumes paid balance.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.verification_records') IS NULL
     OR TO_REGCLASS('public.customer_product_balances') IS NULL
     OR TO_REGPROCEDURE('public.enforce_current_verification_integrity()') IS NULL
     OR TO_REGPROCEDURE('public.review_order_application(character varying,bigint,bigint,character varying,text)') IS NULL
     OR TO_REGPROCEDURE('public.enforce_paid_verification_available_balance_v63()') IS NULL THEN
    RAISE EXCEPTION 'migration 079 requires migrations through 078';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'migration 079 requires the CloudBase service_role';
  END IF;
END;
$$;

LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.enforce_current_verification_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- CURRENT_VERIFICATION_INTEGRITY_V79
  IF TG_OP = 'INSERT' THEN
    IF (NEW.verification_type IN ('NORMAL', 'EXPERIENCE') AND NEW.record_status <> 'APPROVED')
       OR (NEW.verification_type = 'SUPPLEMENT' AND NEW.record_status <> 'PENDING')
       OR NEW.verification_type NOT IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE') THEN
      RAISE EXCEPTION 'verification status does not match its workflow'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.verification_code IS DISTINCT FROM OLD.verification_code
     OR NEW.verification_type IS DISTINCT FROM OLD.verification_type
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.unit_count IS DISTINCT FROM OLD.unit_count
     OR NEW.submitted_by_account_id IS DISTINCT FROM OLD.submitted_by_account_id
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.supplement_note IS DISTINCT FROM OLD.supplement_note
     OR NEW.face_request_id IS DISTINCT FROM OLD.face_request_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.face_subject_type IS DISTINCT FROM OLD.face_subject_type
     OR NEW.face_subject_teacher_id IS DISTINCT FROM OLD.face_subject_teacher_id THEN
    RAISE EXCEPTION 'submitted verification business fields are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    IF OLD.record_status = 'PENDING'
       AND NEW.record_status IN ('APPROVED', 'REJECTED')
       AND NEW.reviewed_by_account_id IS NOT NULL
       AND NEW.reviewed_at IS NOT NULL THEN
      NULL;
    ELSIF OLD.record_status = 'APPROVED'
       AND NEW.record_status = 'VOIDED'
       AND NEW.void_request_status = 'APPROVED' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'invalid verification status transition: % -> %',
        OLD.record_status, NEW.record_status USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.reviewed_by_account_id IS DISTINCT FROM OLD.reviewed_by_account_id
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.review_note IS DISTINCT FROM OLD.review_note THEN
    RAISE EXCEPTION 'verification review fields may change only with the pending decision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_verification_teacher_matrix_v79()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor_role TEXT;
  actor_teacher_id BIGINT;
  has_direct BOOLEAN;
  scope_ok BOOLEAN;
  scope_sql TEXT;
BEGIN
  -- VERIFICATION_TEACHER_MATRIX_V79
  SELECT account.role_code INTO actor_role
    FROM public.staff_accounts AS account
   WHERE account.id = NEW.submitted_by_account_id
     AND account.account_status = 'ACTIVE'
   FOR SHARE;
  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'inactive submitter' USING ERRCODE = '23514';
  END IF;

  IF NEW.teacher_id IS NOT NULL THEN
    PERFORM 1
      FROM public.teachers AS teacher
      JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
     WHERE teacher.id = NEW.teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
     FOR SHARE OF teacher, account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inactive teacher' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF actor_role = 'store' THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stores'
         AND column_name = 'store_account_id'
    ) INTO has_direct;
    IF has_direct THEN
      scope_sql := 'SELECT TRUE FROM public.stores store WHERE store.id = $1 AND store.store_account_id = $2 AND store.store_status = ''ACTIVE'' FOR SHARE OF store';
    ELSIF TO_REGCLASS('public.staff_store_assignments') IS NOT NULL THEN
      scope_sql := 'SELECT TRUE FROM public.staff_store_assignments assignment JOIN public.stores store ON store.id = assignment.store_id WHERE assignment.staff_account_id = $2 AND assignment.store_id = $1 AND assignment.assignment_status = ''ACTIVE'' AND store.store_status = ''ACTIVE'' FOR SHARE OF assignment, store';
    END IF;
    IF scope_sql IS NOT NULL THEN
      EXECUTE scope_sql INTO scope_ok USING NEW.store_id, NEW.submitted_by_account_id;
    END IF;
    IF NOT COALESCE(scope_ok, FALSE) THEN
      RAISE EXCEPTION 'store scope denied' USING ERRCODE = '23514';
    END IF;
    IF NEW.verification_type NOT IN ('NORMAL', 'SUPPLEMENT') THEN
      RAISE EXCEPTION 'store cannot submit EXPERIENCE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF actor_role = 'teacher' THEN
    SELECT teacher.id INTO actor_teacher_id
      FROM public.teachers AS teacher
     WHERE teacher.staff_account_id = NEW.submitted_by_account_id
       AND teacher.teacher_status = 'ACTIVE'
     FOR SHARE;
    IF actor_teacher_id IS NULL OR NEW.teacher_id IS DISTINCT FROM actor_teacher_id THEN
      RAISE EXCEPTION 'teacher order must use own teacher' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'role denied' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_059_verification_business_teacher ON public.verification_records;
DROP TRIGGER IF EXISTS trg_065_verification_business_teacher ON public.verification_records;
DROP TRIGGER IF EXISTS trg_079_verification_business_teacher ON public.verification_records;
CREATE TRIGGER trg_079_verification_business_teacher
BEFORE INSERT ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_verification_teacher_matrix_v79();

CREATE OR REPLACE FUNCTION public.create_supplement_verification_application(
  p_store_id BIGINT,
  p_teacher_id BIGINT,
  p_customer_id BIGINT,
  p_product_id BIGINT,
  p_unit_count INTEGER,
  p_submitted_by_account_id BIGINT,
  p_message TEXT,
  p_idempotency_key VARCHAR
)
RETURNS TABLE(
  id BIGINT,
  verification_code TEXT,
  verification_type TEXT,
  store_id BIGINT,
  teacher_id BIGINT,
  customer_id BIGINT,
  product_id BIGINT,
  unit_count INTEGER,
  record_status TEXT,
  submitted_by_account_id BIGINT,
  submitted_at TIMESTAMPTZ,
  message TEXT,
  idempotency_key TEXT,
  created_now BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing_record public.verification_records%ROWTYPE;
  created_record public.verification_records%ROWTYPE;
  purchased_units BIGINT := 0;
  consumed_units BIGINT := 0;
  materialized_remaining BIGINT := 0;
  available_units BIGINT := 0;
BEGIN
  -- SUPPLEMENT_VERIFICATION_CREATE_V79
  IF p_unit_count IS NULL OR p_unit_count < 1 OR p_unit_count > 999 THEN
    RAISE EXCEPTION 'supplement verification unit count must be between 1 and 999'
      USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = '22023';
  END IF;
  IF LENGTH(COALESCE(p_message, '')) > 500 THEN
    RAISE EXCEPTION 'supplement verification message is too long' USING ERRCODE = '22001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));
  SELECT record.* INTO existing_record
    FROM public.verification_records AS record
   WHERE record.idempotency_key = p_idempotency_key
   LIMIT 1;
  IF existing_record.id IS NOT NULL THEN
    IF existing_record.verification_type <> 'SUPPLEMENT'
       OR existing_record.store_id <> p_store_id
       OR existing_record.teacher_id IS DISTINCT FROM p_teacher_id
       OR existing_record.customer_id <> p_customer_id
       OR existing_record.product_id <> p_product_id
       OR existing_record.unit_count <> p_unit_count
       OR existing_record.submitted_by_account_id <> p_submitted_by_account_id
       OR existing_record.message <> COALESCE(p_message, '')
       OR existing_record.face_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'idempotency key belongs to a different supplement verification request'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing_record.id, existing_record.verification_code::TEXT,
      existing_record.verification_type::TEXT, existing_record.store_id,
      existing_record.teacher_id, existing_record.customer_id,
      existing_record.product_id, existing_record.unit_count,
      existing_record.record_status::TEXT, existing_record.submitted_by_account_id,
      existing_record.submitted_at, existing_record.message,
      existing_record.idempotency_key::TEXT, FALSE;
    RETURN;
  END IF;

  PERFORM 1
    FROM public.customers AS customer
   WHERE customer.id = p_customer_id
     AND customer.created_store_id = p_store_id
     AND customer.customer_status = 'ACTIVE'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer is missing, archived, or belongs to another store'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.stores
   WHERE id = p_store_id AND store_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'store is missing or archived' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.products
   WHERE id = p_product_id AND product_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product is missing or archived' USING ERRCODE = '23514';
  END IF;
  IF p_teacher_id IS NOT NULL THEN
    PERFORM 1
      FROM public.teachers AS teacher
      JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
     WHERE teacher.id = p_teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
     FOR SHARE OF teacher, account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'teacher is missing or archived' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM 1 FROM public.staff_accounts
   WHERE id = p_submitted_by_account_id AND account_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submitting account is missing or archived' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(balance.remaining_count, 0)::BIGINT
    INTO materialized_remaining
    FROM public.customer_product_balances AS balance
   WHERE balance.customer_id = p_customer_id
     AND balance.product_id = p_product_id
   FOR UPDATE;
  materialized_remaining := COALESCE(materialized_remaining, 0);

  SELECT GREATEST(COALESCE(SUM(
           CASE WHEN recharge.recharge_type = 'NEW'
                THEN recharge.unit_count ELSE -recharge.unit_count END
         ), 0), 0)::BIGINT
    INTO purchased_units
    FROM public.recharge_records AS recharge
   WHERE recharge.customer_id = p_customer_id
     AND recharge.product_id = p_product_id
     AND recharge.record_status = 'APPROVED';

  SELECT COALESCE(SUM(verification.unit_count), 0)::BIGINT
    INTO consumed_units
    FROM public.verification_records AS verification
   WHERE verification.customer_id = p_customer_id
     AND verification.product_id = p_product_id
     AND verification.record_status = 'APPROVED'
     AND verification.verification_type IN ('NORMAL', 'SUPPLEMENT');

  available_units := LEAST(
    materialized_remaining,
    GREATEST(purchased_units - consumed_units, 0)
  );
  IF available_units < p_unit_count THEN
    RAISE EXCEPTION 'insufficient purchased units for supplement verification'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.verification_records
    (verification_type, store_id, teacher_id, customer_id, product_id,
     unit_count, record_status, submitted_by_account_id, message,
     supplement_note, face_request_id, idempotency_key,
     face_subject_type, face_subject_teacher_id)
  VALUES
    ('SUPPLEMENT', p_store_id, p_teacher_id, p_customer_id, p_product_id,
     p_unit_count, 'PENDING', p_submitted_by_account_id,
     COALESCE(p_message, ''), '', NULL, p_idempotency_key,
     'CUSTOMER', NULL)
  RETURNING * INTO created_record;

  RETURN QUERY SELECT created_record.id, created_record.verification_code::TEXT,
    created_record.verification_type::TEXT, created_record.store_id,
    created_record.teacher_id, created_record.customer_id,
    created_record.product_id, created_record.unit_count,
    created_record.record_status::TEXT, created_record.submitted_by_account_id,
    created_record.submitted_at, created_record.message,
    created_record.idempotency_key::TEXT, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_current_verification_integrity()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_verification_teacher_matrix_v79()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_supplement_verification_application(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT, VARCHAR
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_current_verification_integrity()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_verification_teacher_matrix_v79()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_supplement_verification_application(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT, VARCHAR
) TO service_role;

COMMENT ON FUNCTION public.create_supplement_verification_application(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT, VARCHAR
) IS 'Migration 079: idempotent store/teacher supplemental verification submission; creates PENDING without face photos, BLE authorization or device signal.';
COMMENT ON FUNCTION public.enforce_verification_teacher_matrix_v79() IS
  'Migration 079: store may submit NORMAL or SUPPLEMENT; teacher submissions remain self-bound; EXPERIENCE remains teacher-only.';
COMMENT ON FUNCTION public.enforce_current_verification_integrity() IS
  'Migration 079: NORMAL/EXPERIENCE start APPROVED; SUPPLEMENT starts PENDING and only HQ may decide it.';

COMMIT;

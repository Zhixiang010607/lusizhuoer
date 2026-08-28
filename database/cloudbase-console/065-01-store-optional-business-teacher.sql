-- Migration 065: store accounts may optionally attribute every supported
-- business order to an active teacher. Teacher accounts remain bound to self.
-- Store EXPERIENCE verification remains forbidden.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.recharge_records') IS NULL
     OR TO_REGCLASS('public.verification_records') IS NULL
     OR TO_REGCLASS('public.retail_product_purchase_records') IS NULL
     OR TO_REGCLASS('public.device_signal_outbox') IS NULL
     OR TO_REGPROCEDURE('public.enforce_business_teacher_matrix_v59()') IS NULL
     OR TO_REGPROCEDURE('public.validate_retail_product_purchase_insert()') IS NULL
     OR TO_REGPROCEDURE('public.lock_active_verification_subjects(bigint,bigint,bigint,bigint,bigint)') IS NULL
     OR TO_REGPROCEDURE('public.assert_matching_verification_idempotency(bigint,character varying,bigint,bigint,bigint,bigint,bigint,text,text,character varying,character varying)') IS NULL THEN
    RAISE EXCEPTION 'migration 065 prerequisites are missing; execute migrations through 064 first';
  END IF;
END;
$$;

LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.retail_product_purchase_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.device_signal_outbox IN SHARE ROW EXCLUSIVE MODE;

-- A store NORMAL verification may intentionally have no attributed teacher.
-- EXPERIENCE remains teacher-only and therefore still always has a teacher.
ALTER TABLE public.recharge_records
  DROP CONSTRAINT IF EXISTS recharge_records_teacher_required;
ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_teacher_required;
ALTER TABLE public.recharge_records ALTER COLUMN teacher_id DROP NOT NULL;
ALTER TABLE public.verification_records ALTER COLUMN teacher_id DROP NOT NULL;
ALTER TABLE public.device_signal_outbox ALTER COLUMN teacher_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.lock_active_verification_subjects(
  p_store_id BIGINT,
  p_teacher_id BIGINT,
  p_customer_id BIGINT,
  p_product_id BIGINT,
  p_submitted_by_account_id BIGINT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE profile_object_ref TEXT;
BEGIN
  -- OPTIONAL_VERIFICATION_TEACHER_V65
  PERFORM 1 FROM public.stores
   WHERE id = p_store_id AND store_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store is missing or archived' USING ERRCODE = '23514'; END IF;

  PERFORM 1 FROM public.customers
   WHERE id = p_customer_id
     AND created_store_id = p_store_id
     AND customer_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer is missing, archived, or belongs to another store' USING ERRCODE = '23514'; END IF;

  PERFORM 1 FROM public.products
   WHERE id = p_product_id AND product_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product is missing or archived' USING ERRCODE = '23514'; END IF;

  IF p_teacher_id IS NOT NULL THEN
    PERFORM 1 FROM public.teachers teacher
     WHERE teacher.id = p_teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND EXISTS (
         SELECT 1 FROM public.staff_accounts account
          WHERE account.id = teacher.staff_account_id
            AND account.role_code = 'teacher'
            AND account.account_status = 'ACTIVE'
       ) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'teacher is missing or archived' USING ERRCODE = '23514'; END IF;
  END IF;

  PERFORM 1 FROM public.staff_accounts
   WHERE id = p_submitted_by_account_id AND account_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'submitting account is missing or archived' USING ERRCODE = '23514'; END IF;

  SELECT profile_photo_file_id INTO profile_object_ref
    FROM public.customers WHERE id = p_customer_id FOR SHARE;
  IF BTRIM(COALESCE(profile_object_ref, '')) = '' THEN
    RAISE EXCEPTION 'customer retained profile photo is required' USING ERRCODE = '22023';
  END IF;
  RETURN profile_object_ref;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_matching_verification_idempotency(
  p_verification_id BIGINT, p_verification_type VARCHAR, p_store_id BIGINT,
  p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_supplement_note TEXT,
  p_face_request_id VARCHAR, p_face_evidence_token VARCHAR
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- NULL_SAFE_TEACHER_IDEMPOTENCY_V65
  IF NOT EXISTS (
    SELECT 1 FROM public.verification_records v
     WHERE v.id = p_verification_id AND v.verification_type = p_verification_type
       AND v.store_id = p_store_id AND v.teacher_id IS NOT DISTINCT FROM p_teacher_id
       AND v.customer_id = p_customer_id AND v.product_id = p_product_id
       AND v.submitted_by_account_id = p_submitted_by_account_id
       AND v.message = COALESCE(p_message, '')
       AND v.supplement_note = COALESCE(p_supplement_note, '')
       AND v.face_request_id = p_face_request_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.verification_photos photo
     WHERE photo.verification_id = p_verification_id
       AND photo.photo_slot = 0 AND photo.photo_kind = 'PROFILE'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.verification_photos photo
     WHERE photo.verification_id = p_verification_id
       AND photo.photo_slot = 1 AND photo.photo_kind = 'FACE'
       AND photo.source_evidence_token = p_face_evidence_token
  ) THEN
    RAISE EXCEPTION 'idempotency key belongs to a different verification request' USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_business_teacher_matrix_v65()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_role TEXT;
  actor_teacher_id BIGINT;
  order_type TEXT;
  has_direct BOOLEAN;
  scope_ok BOOLEAN;
  scope_sql TEXT;
BEGIN
  -- BUSINESS_TEACHER_MATRIX_V65
  SELECT account.role_code INTO actor_role
    FROM public.staff_accounts account
   WHERE account.id = NEW.submitted_by_account_id
     AND account.account_status = 'ACTIVE'
   FOR SHARE;
  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'inactive submitter' USING ERRCODE = '23514';
  END IF;

  IF NEW.teacher_id IS NOT NULL THEN
    PERFORM 1 FROM public.teachers teacher
      JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
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
    IF TG_TABLE_NAME = 'verification_records' THEN
      order_type := UPPER(COALESCE(TO_JSONB(NEW)->>'verification_type', ''));
      IF order_type <> 'NORMAL' THEN
        -- STORE_EXPERIENCE_DENIED_V65
        RAISE EXCEPTION 'store cannot submit EXPERIENCE' USING ERRCODE = '23514';
      END IF;
    END IF;
    -- STORE_BUSINESS_TEACHER_OPTIONAL_V65
    RETURN NEW;
  END IF;

  IF actor_role = 'teacher' THEN
    SELECT teacher.id INTO actor_teacher_id
      FROM public.teachers teacher
     WHERE teacher.staff_account_id = NEW.submitted_by_account_id
       AND teacher.teacher_status = 'ACTIVE'
     FOR SHARE;
    IF actor_teacher_id IS NULL OR NEW.teacher_id IS DISTINCT FROM actor_teacher_id THEN
      -- TEACHER_SELF_ATTRIBUTION_V65
      RAISE EXCEPTION 'teacher order must use own teacher' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'role denied' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_059_recharge_business_teacher ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_059_verification_business_teacher ON public.verification_records;
DROP TRIGGER IF EXISTS trg_065_recharge_business_teacher ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_065_verification_business_teacher ON public.verification_records;

CREATE TRIGGER trg_065_recharge_business_teacher
BEFORE INSERT ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_business_teacher_matrix_v65();

CREATE TRIGGER trg_065_verification_business_teacher
BEFORE INSERT ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_business_teacher_matrix_v65();

CREATE OR REPLACE FUNCTION public.validate_retail_product_purchase_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  selected_product public.retail_products%ROWTYPE;
  selected_customer public.customers%ROWTYPE;
  submitter public.staff_accounts%ROWTYPE;
  bound_teacher public.teachers%ROWTYPE;
BEGIN
  -- STORE_RETAIL_PRODUCT_TEACHER_OPTIONAL_V65
  SELECT * INTO selected_product FROM public.retail_products
   WHERE id = NEW.retail_product_id FOR KEY SHARE;
  IF NOT FOUND OR selected_product.product_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'RETAIL_PRODUCT_PURCHASE_PRODUCT_NOT_ACTIVE';
  END IF;
  SELECT * INTO selected_customer FROM public.customers
   WHERE id = NEW.customer_id FOR KEY SHARE;
  IF NOT FOUND OR selected_customer.customer_status <> 'ACTIVE'
     OR selected_customer.created_store_id <> NEW.store_id THEN
    RAISE EXCEPTION 'RETAIL_PRODUCT_PURCHASE_CUSTOMER_SCOPE_INVALID';
  END IF;
  SELECT * INTO submitter FROM public.staff_accounts
   WHERE id = NEW.submitted_by_account_id FOR KEY SHARE;
  IF NOT FOUND OR submitter.account_status <> 'ACTIVE'
     OR submitter.role_code NOT IN ('store', 'teacher') THEN
    RAISE EXCEPTION 'RETAIL_PRODUCT_PURCHASE_SUBMITTER_INVALID';
  END IF;
  IF submitter.role_code = 'teacher' THEN
    SELECT * INTO bound_teacher FROM public.teachers
     WHERE staff_account_id = submitter.id
       AND teacher_status = 'ACTIVE' FOR KEY SHARE;
    IF NOT FOUND OR NEW.teacher_id IS DISTINCT FROM bound_teacher.id THEN
      RAISE EXCEPTION 'RETAIL_PRODUCT_PURCHASE_TEACHER_BINDING_INVALID';
    END IF;
  ELSIF NEW.teacher_id IS NOT NULL THEN
    PERFORM 1 FROM public.teachers teacher
      JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
     WHERE teacher.id = NEW.teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
     FOR KEY SHARE OF teacher, account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RETAIL_PRODUCT_PURCHASE_TEACHER_BINDING_INVALID';
    END IF;
  END IF;
  NEW.product_code_snapshot := selected_product.product_code;
  NEW.product_name_snapshot := selected_product.product_name;
  NEW.record_status := 'PENDING';
  NEW.reviewed_by_account_id := NULL;
  NEW.reviewed_at := NULL;
  NEW.review_note := '';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_business_teacher_matrix_v65()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_business_teacher_matrix_v65()
  TO service_role;
REVOKE ALL ON FUNCTION public.lock_active_verification_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_active_verification_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT)
  TO service_role;
REVOKE ALL ON FUNCTION public.assert_matching_verification_idempotency(BIGINT, VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, VARCHAR, VARCHAR)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_matching_verification_idempotency(BIGINT, VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, VARCHAR, VARCHAR)
  TO service_role;
REVOKE ALL ON FUNCTION public.validate_retail_product_purchase_insert()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_retail_product_purchase_insert()
  TO service_role;

COMMENT ON FUNCTION public.enforce_business_teacher_matrix_v65() IS
  'Migration 065: store business teacher is optional; teacher actor is self-bound; store experience remains forbidden.';
COMMENT ON FUNCTION public.validate_retail_product_purchase_insert() IS
  'Migration 065: store retail-product purchase teacher is optional and validated when selected.';

COMMIT;

-- Migration 080: qualify table identifiers inside the supplemental verification
-- submission function. Migration 079 declared an output column named `id`, so
-- unqualified table predicates such as `WHERE id = p_store_id` fail at runtime
-- with SQLSTATE 42702 before any record is inserted.

BEGIN;

DO $$
BEGIN
  IF TO_REGPROCEDURE(
    'public.create_supplement_verification_application(bigint,bigint,bigint,bigint,integer,bigint,text,character varying)'
  ) IS NULL THEN
    RAISE EXCEPTION 'migration 079 create_supplement_verification_application is missing';
  END IF;
END;
$$;

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
  -- SUPPLEMENT_VERIFICATION_CREATE_V80
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

  PERFORM 1 FROM public.stores AS store
   WHERE store.id = p_store_id AND store.store_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'store is missing or archived' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.products AS product
   WHERE product.id = p_product_id AND product.product_status = 'ACTIVE' FOR SHARE;
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
  PERFORM 1 FROM public.staff_accounts AS submitter
   WHERE submitter.id = p_submitted_by_account_id
     AND submitter.account_status = 'ACTIVE'
   FOR SHARE;
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

REVOKE ALL ON FUNCTION public.create_supplement_verification_application(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT, VARCHAR
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_supplement_verification_application(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT, VARCHAR
) TO service_role;

COMMENT ON FUNCTION public.create_supplement_verification_application(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT, VARCHAR
) IS 'Migration 080: idempotent store/teacher supplemental submission with qualified identifiers; creates PENDING without face photos, BLE authorization or device signal.';

COMMIT;

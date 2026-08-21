-- Remove the last legacy teacher-face prerequisites from new business orders.
-- Teacher/account activation remains mandatory. Customer retained-photo and
-- live 1:1 customer-face checks remain mandatory for verification records.
BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.teachers') IS NULL
     OR TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGPROCEDURE('public.assert_active_order_master_data()') IS NULL
     OR TO_REGPROCEDURE('public.lock_active_verification_subjects(bigint,bigint,bigint,bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'migration 055 prerequisites are missing; execute migrations through 054 first';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_active_order_master_data()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stores
     WHERE id = NEW.store_id AND store_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing store cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers
     WHERE id = NEW.customer_id
       AND created_store_id = NEW.store_id
       AND customer_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived, missing, or foreign-store customer cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = NEW.product_id AND product_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing product cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NEW.teacher_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.teachers AS teacher
      JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
     WHERE teacher.id = NEW.teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing teacher cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_accounts
     WHERE id = NEW.submitted_by_account_id
       AND account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived submitting account cannot create a new order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

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

REVOKE ALL ON FUNCTION public.assert_active_order_master_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_active_verification_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;

COMMENT ON FUNCTION public.assert_active_order_master_data() IS
  'New-order master-data guard: active teacher/account required; teacher face enrollment is not required.';
COMMENT ON FUNCTION public.lock_active_verification_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) IS
  'Locks active order subjects and the customer retained photo; no teacher face dependency.';

COMMIT;

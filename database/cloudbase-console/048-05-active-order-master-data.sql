-- CloudBase migration 048, part 5 / 7. Run this file by itself.
BEGIN;
-- These order-level predicates are the final authorization boundary for new
-- business records. Teacher face enrollment is deliberately absent: the
-- customer face capture in a verification remains mandatory and independent.
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
  PERFORM 1 FROM public.stores WHERE id = p_store_id AND store_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store is missing or archived' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.customers
   WHERE id = p_customer_id AND created_store_id = p_store_id AND customer_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer is missing, archived, or belongs to another store' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.products WHERE id = p_product_id AND product_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product is missing or archived' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.teachers teacher
   WHERE teacher.id = p_teacher_id AND teacher.teacher_status = 'ACTIVE'
     AND EXISTS (SELECT 1 FROM public.staff_accounts account
                  WHERE account.id = teacher.staff_account_id
                    AND account.role_code = 'teacher' AND account.account_status = 'ACTIVE') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'teacher is missing or archived' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.staff_accounts
   WHERE id = p_submitted_by_account_id AND account_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'submitting account is missing or archived' USING ERRCODE = '23514'; END IF;
  SELECT profile_photo_file_id INTO profile_object_ref FROM public.customers WHERE id = p_customer_id FOR SHARE;
  IF BTRIM(COALESCE(profile_object_ref, '')) = '' THEN
    RAISE EXCEPTION 'customer retained profile photo is required' USING ERRCODE = '22023';
  END IF;
  RETURN profile_object_ref;
END;
$$;

COMMIT;

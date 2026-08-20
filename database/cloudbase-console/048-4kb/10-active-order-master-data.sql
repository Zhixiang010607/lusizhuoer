-- 048 fallback, 11/15. New orders require active master data; teacher face is not a condition.
BEGIN;
CREATE OR REPLACE FUNCTION public.assert_active_order_master_data()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stores WHERE id = NEW.store_id AND store_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing store cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers
     WHERE id = NEW.customer_id AND created_store_id = NEW.store_id AND customer_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived, missing, or foreign-store customer cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = NEW.product_id AND product_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing product cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NEW.teacher_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.teachers AS teacher
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
     WHERE id = NEW.submitted_by_account_id AND account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived submitting account cannot create a new order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;

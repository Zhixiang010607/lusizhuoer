-- Migration 059, step 0: verify the required tables and one store binding layout.
BEGIN;

DO $$
DECLARE
  has_direct_store_binding BOOLEAN;
BEGIN
  IF TO_REGCLASS('public.recharge_records') IS NULL
     OR TO_REGCLASS('public.verification_records') IS NULL
     OR TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGCLASS('public.stores') IS NULL
     OR TO_REGCLASS('public.teachers') IS NULL THEN
    RAISE EXCEPTION 'migration 059 prerequisites are missing; execute migrations through 058 first';
  END IF;
  IF (SELECT COUNT(DISTINCT column_name) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stores'
         AND column_name IN ('id', 'store_status')) <> 2 THEN
    RAISE EXCEPTION 'migration 059 requires store id and status columns';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'stores'
       AND column_name = 'store_account_id'
  ) INTO has_direct_store_binding;
  IF NOT has_direct_store_binding AND (
    TO_REGCLASS('public.staff_store_assignments') IS NULL OR
    (SELECT COUNT(DISTINCT column_name) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'staff_store_assignments'
        AND column_name IN ('staff_account_id', 'store_id', 'assignment_status')) <> 3
  ) THEN
    RAISE EXCEPTION 'migration 059 requires a current or legacy store account binding layout';
  END IF;
END;
$$;

COMMIT;

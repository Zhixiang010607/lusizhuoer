-- CloudBase console migration 057. Execute this entire file once.
-- Existing rows stay unassigned because historical creator identity was not stored.
BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.customers') IS NULL
     OR TO_REGCLASS('public.staff_accounts') IS NULL THEN
    RAISE EXCEPTION 'migration 057 prerequisites are missing; execute migrations through 056 first';
  END IF;
END;
$$;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS created_by_account_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.customers'::regclass
       AND conname = 'customers_created_by_account_id_fkey'
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_created_by_account_id_fkey
      FOREIGN KEY (created_by_account_id)
      REFERENCES public.staff_accounts(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_customers_created_by_account
  ON public.customers (created_by_account_id, created_at DESC, id DESC)
  WHERE created_by_account_id IS NOT NULL;

COMMENT ON COLUMN public.customers.created_by_account_id IS
  'Account that created this customer. Teacher access is granted only when this is that teacher account or an approved verification relationship exists; a store creator never binds a teacher.';

COMMIT;

SELECT 'column' AS kind,
       'public.customers.created_by_account_id' AS object_name,
       CASE WHEN EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'customers'
            AND column_name = 'created_by_account_id'
       ) THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'constraint', 'public.customers_created_by_account_id_fkey',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.customers'::regclass
            AND conname = 'customers_created_by_account_id_fkey'
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'index', 'public.idx_customers_created_by_account',
       CASE WHEN TO_REGCLASS('public.idx_customers_created_by_account') IS NOT NULL
            THEN 'READY' ELSE 'MISSING' END;

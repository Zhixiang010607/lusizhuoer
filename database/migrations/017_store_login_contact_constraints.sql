-- One store has one active login account and one active login contact.
-- Run this only after resolving any pre-existing duplicate active assignments
-- or contacts reported by the checks below.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.staff_store_assignments') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.staff_store_assignments
      WHERE assignment_status = 'ACTIVE'
      GROUP BY store_id
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'store has more than one active login account';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.staff_store_assignments
      WHERE assignment_status = 'ACTIVE'
      GROUP BY staff_account_id
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'active store account is assigned to more than one store';
    END IF;

    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_store_per_store_account
      ON public.staff_store_assignments (staff_account_id)
      WHERE assignment_status = ''ACTIVE''';

    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_account_per_store
      ON public.staff_store_assignments (store_id)
      WHERE assignment_status = ''ACTIVE''';
  END IF;

  IF to_regclass('public.store_contacts') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.store_contacts
      WHERE contact_status = 'ACTIVE'
      GROUP BY store_id
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'store has more than one active contact';
    END IF;

    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_store_contact
      ON public.store_contacts (store_id)
      WHERE contact_status = ''ACTIVE''';

    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_store_contacts_active_phone
      ON public.store_contacts (contact_phone)
      WHERE contact_status = ''ACTIVE''';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'contacts_json'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_stores_contacts_json_gin
      ON public.stores USING GIN (contacts_json)';
  END IF;
END
$$;

COMMIT;

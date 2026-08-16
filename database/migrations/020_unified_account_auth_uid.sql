BEGIN;

LOCK TABLE public.staff_accounts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.staff_accounts
    WHERE auth_uid IS NULL OR BTRIM(auth_uid) = ''
  ) THEN
    RAISE EXCEPTION 'Every staff account must have a non-empty CloudBase auth_uid before applying migration 020.';
  END IF;
END;
$$;

ALTER TABLE public.staff_accounts
  ALTER COLUMN auth_uid SET NOT NULL;

ALTER TABLE public.staff_accounts
  DROP CONSTRAINT IF EXISTS staff_accounts_auth_uid_not_blank;

ALTER TABLE public.staff_accounts
  ADD CONSTRAINT staff_accounts_auth_uid_not_blank
  CHECK (BTRIM(auth_uid) <> '');

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_accounts_auth_uid
  ON public.staff_accounts (auth_uid);

COMMIT;

-- SAFE PUBLIC-REPOSITORY STUB.
--
-- The former one-time production cleanup embedded a retained-account list.
-- Production identities and destructive allowlists must never be committed to
-- this public repository or reused from historical chat context.
--
-- Before any future cleanup, the operator must:
--   1. obtain the user's explicit confirmation of the current retained set;
--   2. generate a private, exact-match allowlist outside the repository;
--   3. run and review a read-only preview in the target environment; and
--   4. execute the private cleanup only in a separately confirmed change window.
--
-- This checked-in file intentionally has no destructive statement and always
-- refuses execution. It is documentation and a safety tripwire, not a runnable
-- cleanup migration.

BEGIN;

DO $$
BEGIN
  RAISE EXCEPTION
    'public cleanup stub: create a private exact-match script only after explicit user confirmation and a read-only preview'
    USING ERRCODE = '55000';
END;
$$;

ROLLBACK;

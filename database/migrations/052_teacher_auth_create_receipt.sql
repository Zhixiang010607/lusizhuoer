-- Persist the authoritative CloudBase Auth createUser receipt separately from
-- the deterministic UID requested before the cross-service teacher saga.
-- Migration 052 must be deployed after 051 and before staffAccount v62.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.teacher_face_operations') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'teacher_face_operations'
          AND column_name IN ('auth_uid', 'auth_owner_token_sha256')
        GROUP BY table_schema, table_name
       HAVING COUNT(*) = 2
     ) THEN
    RAISE EXCEPTION 'teacher Auth create receipt prerequisites are missing; execute migration 051 first';
  END IF;
END;
$$;

ALTER TABLE public.teacher_face_operations
  ADD COLUMN IF NOT EXISTS auth_create_returned_uid VARCHAR(128),
  ADD COLUMN IF NOT EXISTS auth_create_confirmed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.teacher_face_operations'::regclass
       AND conname = 'teacher_face_operation_auth_create_receipt_valid'
  ) THEN
    ALTER TABLE public.teacher_face_operations
      ADD CONSTRAINT teacher_face_operation_auth_create_receipt_valid CHECK (
        auth_create_returned_uid IS NULL
        OR (BTRIM(auth_create_returned_uid) <> '' AND CHAR_LENGTH(auth_create_returned_uid) <= 128)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.teacher_face_operations'::regclass
       AND conname = 'teacher_face_operation_auth_create_receipt_pair'
  ) THEN
    ALTER TABLE public.teacher_face_operations
      ADD CONSTRAINT teacher_face_operation_auth_create_receipt_pair CHECK (
        (auth_create_returned_uid IS NULL AND auth_create_confirmed_at IS NULL)
        OR (
          auth_create_returned_uid IS NOT NULL
          AND auth_create_confirmed_at IS NOT NULL
          AND operation_type = 'PROVISION'
          AND auth_uid IS NOT NULL
          AND auth_owner_token_sha256 IS NOT NULL
        )
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.teacher_face_operations.auth_create_returned_uid IS
  'Migration 052 exact UID returned by a successful CloudBase Auth createUser response; distinct from the requested auth_uid.';
COMMENT ON COLUMN public.teacher_face_operations.auth_create_confirmed_at IS
  'Migration 052 time when the fenced saga durably recorded the successful CloudBase Auth createUser response.';

REVOKE ALL ON TABLE public.teacher_face_operations FROM PUBLIC;

COMMIT;

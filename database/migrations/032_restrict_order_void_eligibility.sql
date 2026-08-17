BEGIN;

-- Only the three supported business orders may ever enter a void lifecycle:
--   recharge NEW, verification NORMAL and verification SUPPLEMENT.
-- The application also checks this rule, but PostgreSQL remains the authority
-- so a direct or stale client cannot bypass it.
DO $$
BEGIN
  IF TO_REGPROCEDURE('public.request_order_void(character varying,bigint,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 026 must be executed before migration 032';
  END IF;
END;
$$;

ALTER TABLE public.recharge_records
  DROP CONSTRAINT IF EXISTS recharge_records_void_request_type_check;
ALTER TABLE public.recharge_records
  ADD CONSTRAINT recharge_records_void_request_type_check
  CHECK (
    recharge_type = 'NEW'
    OR void_request_status IN ('NONE', 'REJECTED')
  ) NOT VALID;

ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_void_request_type_check;
ALTER TABLE public.verification_records
  ADD CONSTRAINT verification_records_void_request_type_check
  CHECK (
    verification_type IN ('NORMAL', 'SUPPLEMENT')
    OR void_request_status IN ('NONE', 'REJECTED')
  ) NOT VALID;

-- NOT VALID still enforces every new INSERT/UPDATE. Validate immediately when
-- historical data is already clean. Unsupported legacy PENDING applications
-- remain rejectable for audit retention, while approving them is blocked.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.recharge_records
     WHERE recharge_type <> 'NEW'
       AND void_request_status NOT IN ('NONE', 'REJECTED')
  ) THEN
    EXECUTE 'ALTER TABLE public.recharge_records VALIDATE CONSTRAINT recharge_records_void_request_type_check';
  ELSE
    RAISE NOTICE 'recharge_records contains unsupported historical void lifecycles; constraint remains NOT VALID pending audit';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.verification_records
     WHERE verification_type NOT IN ('NORMAL', 'SUPPLEMENT')
       AND void_request_status NOT IN ('NONE', 'REJECTED')
  ) THEN
    EXECUTE 'ALTER TABLE public.verification_records VALIDATE CONSTRAINT verification_records_void_request_type_check';
  ELSE
    RAISE NOTICE 'verification_records contains unsupported historical void lifecycles; constraint remains NOT VALID pending audit';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_order_void(
  p_record_type VARCHAR,
  p_record_id BIGINT,
  p_actor_account_id BIGINT,
  p_note TEXT
)
RETURNS TABLE(record_id BIGINT, record_code TEXT, record_status TEXT,
              void_request_status TEXT, void_requested_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_record_type TEXT := UPPER(COALESCE(p_record_type, ''));
  actor_role TEXT;
  actor_store_id BIGINT;
  current_status TEXT;
  current_void_status TEXT;
  current_store_id BIGINT;
  current_code TEXT;
  current_order_type TEXT;
BEGIN
  IF BTRIM(COALESCE(p_note, '')) = '' THEN
    RAISE EXCEPTION 'void request note is required' USING ERRCODE = '23514';
  END IF;
  IF LENGTH(p_note) > 1000 THEN
    RAISE EXCEPTION 'void request note is too long' USING ERRCODE = '22001';
  END IF;

  SELECT a.role_code, s.id
    INTO actor_role, actor_store_id
    FROM public.staff_accounts AS a
    LEFT JOIN public.stores AS s
      ON s.store_account_id = a.id AND s.store_status = 'ACTIVE'
   WHERE a.id = p_actor_account_id AND a.account_status = 'ACTIVE';
  IF actor_role <> 'store' OR actor_store_id IS NULL THEN
    RAISE EXCEPTION 'only an active bound store account can request a void'
      USING ERRCODE = '42501';
  END IF;

  IF normalized_record_type = 'RECHARGE' THEN
    SELECT r.record_status, r.void_request_status, r.store_id,
           r.recharge_code, r.recharge_type
      INTO current_status, current_void_status, current_store_id,
           current_code, current_order_type
      FROM public.recharge_records AS r
     WHERE r.id = p_record_id
       FOR UPDATE;
  ELSIF normalized_record_type = 'VERIFICATION' THEN
    SELECT v.record_status, v.void_request_status, v.store_id,
           v.verification_code, v.verification_type
      INTO current_status, current_void_status, current_store_id,
           current_code, current_order_type
      FROM public.verification_records AS v
     WHERE v.id = p_record_id
       FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'unsupported record type' USING ERRCODE = '22023';
  END IF;

  IF current_code IS NULL THEN
    RAISE EXCEPTION 'order does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF current_store_id <> actor_store_id THEN
    RAISE EXCEPTION 'the order does not belong to this store' USING ERRCODE = '42501';
  END IF;
  IF (
    normalized_record_type = 'RECHARGE'
    AND UPPER(COALESCE(current_order_type, '')) <> 'NEW'
  ) OR (
    normalized_record_type = 'VERIFICATION'
    AND UPPER(COALESCE(current_order_type, '')) NOT IN ('NORMAL', 'SUPPLEMENT')
  ) THEN
    RAISE EXCEPTION 'order type cannot request a void' USING ERRCODE = '23514';
  END IF;
  IF current_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'only an approved order can request a void' USING ERRCODE = '23514';
  END IF;
  IF current_void_status <> 'NONE' THEN
    RAISE EXCEPTION 'this order already has a void review lifecycle' USING ERRCODE = '23514';
  END IF;

  IF normalized_record_type = 'RECHARGE' THEN
    UPDATE public.recharge_records AS r
       SET void_request_status = 'PENDING',
           void_requested_by_account_id = p_actor_account_id,
           void_request_note = BTRIM(p_note),
           void_requested_at = NOW(),
           updated_at = NOW()
     WHERE r.id = p_record_id;
  ELSE
    UPDATE public.verification_records AS v
       SET void_request_status = 'PENDING',
           void_requested_by_account_id = p_actor_account_id,
           void_request_note = BTRIM(p_note),
           void_requested_at = NOW(),
           updated_at = NOW()
     WHERE v.id = p_record_id;
  END IF;

  RETURN QUERY
  SELECT p_record_id, current_code, current_status, 'PENDING'::TEXT, NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.request_order_void(VARCHAR, BIGINT, BIGINT, TEXT) FROM PUBLIC;

COMMENT ON FUNCTION public.request_order_void(VARCHAR, BIGINT, BIGINT, TEXT) IS
  'Migration 032: allows an active bound store to request one void for its approved NEW recharge or NORMAL/SUPPLEMENT verification order.';

COMMIT;

BEGIN;

-- Verification orders are final business records. If a verification was made
-- by mistake, staff must submit a separate recharge application to restore the
-- unit. Historical approved/rejected verification voids remain readable for
-- audit, but no new verification order may enter or change a void lifecycle.
DO $$
BEGIN
  IF TO_REGPROCEDURE('public.request_order_void(character varying,bigint,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 026 must be executed before migration 036';
  END IF;
END;
$$;

LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;

-- Drop the guard before closing any legacy pending row. This also makes the
-- migration safely rerunnable after a partially managed deployment.
DROP TRIGGER IF EXISTS trg_reject_verification_void_transition
  ON public.verification_records;

-- Close legacy requests that were still waiting when the feature was retired.
-- The requester ID is retained in the reviewer column only as a system closure
-- marker; the explicit note makes clear that no human reviewer made this
-- decision. The original APPROVED verification and customer balance are not
-- changed.
UPDATE public.verification_records
   SET void_request_status = 'REJECTED',
       void_reviewed_by_account_id = void_requested_by_account_id,
       void_reviewed_at = NOW(),
       void_review_note = '系统关闭：核销作废功能已停用；如需补回次数，请提交充值工单。',
       updated_at = NOW()
 WHERE void_request_status = 'PENDING';

ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_void_request_type_check,
  DROP CONSTRAINT IF EXISTS verification_records_void_disabled_check;

ALTER TABLE public.verification_records
  ADD CONSTRAINT verification_records_void_disabled_check
  CHECK (void_request_status <> 'PENDING');

CREATE OR REPLACE FUNCTION public.reject_verification_void_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.void_request_status <> 'NONE' THEN
      RAISE EXCEPTION 'verification orders cannot enter a void lifecycle'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.void_request_status IS DISTINCT FROM OLD.void_request_status THEN
    RAISE EXCEPTION 'verification order void status is immutable because the void workflow is disabled'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.record_status IS DISTINCT FROM OLD.record_status
     AND NEW.record_status = 'VOIDED' THEN
    RAISE EXCEPTION 'verification orders cannot transition to VOIDED because the void workflow is disabled'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reject_verification_void_transition
BEFORE INSERT OR UPDATE OF void_request_status, record_status ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.reject_verification_void_transition();

DROP INDEX IF EXISTS public.idx_verification_void_review_queue;

-- Retire the legacy direct SQL entry point as well. The supported correction
-- is a separate recharge application, never mutation of a verification row.
DROP FUNCTION IF EXISTS public.void_verification_record(BIGINT, BIGINT, TEXT);

-- Keep the public signature stable for existing recharge clients, but make
-- RECHARGE the only accepted record type. PostgreSQL remains the authority
-- even if a stale page or direct API call still tries to void a verification.
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
  IF normalized_record_type <> 'RECHARGE' THEN
    RAISE EXCEPTION 'verification orders cannot request a void; submit a recharge application to restore units'
      USING ERRCODE = '23514';
  END IF;
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

  SELECT r.record_status, r.void_request_status, r.store_id,
         r.recharge_code, r.recharge_type
    INTO current_status, current_void_status, current_store_id,
         current_code, current_order_type
    FROM public.recharge_records AS r
   WHERE r.id = p_record_id
     FOR UPDATE;

  IF current_code IS NULL THEN
    RAISE EXCEPTION 'order does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF current_store_id <> actor_store_id THEN
    RAISE EXCEPTION 'the order does not belong to this store' USING ERRCODE = '42501';
  END IF;
  IF UPPER(COALESCE(current_order_type, '')) <> 'NEW' THEN
    RAISE EXCEPTION 'order type cannot request a void' USING ERRCODE = '23514';
  END IF;
  IF current_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'only an approved order can request a void' USING ERRCODE = '23514';
  END IF;
  IF current_void_status <> 'NONE' THEN
    RAISE EXCEPTION 'this order already has a void review lifecycle' USING ERRCODE = '23514';
  END IF;

  UPDATE public.recharge_records AS r
     SET void_request_status = 'PENDING',
         void_requested_by_account_id = p_actor_account_id,
         void_request_note = BTRIM(p_note),
         void_requested_at = NOW(),
         updated_at = NOW()
   WHERE r.id = p_record_id;

  RETURN QUERY
  SELECT p_record_id, current_code, current_status, 'PENDING'::TEXT, NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.request_order_void(VARCHAR, BIGINT, BIGINT, TEXT) FROM PUBLIC;

COMMENT ON FUNCTION public.request_order_void(VARCHAR, BIGINT, BIGINT, TEXT) IS
  'Migration 036: only approved NEW recharge orders can request a void; verification voids are disabled.';
COMMENT ON FUNCTION public.reject_verification_void_transition() IS
  'Migration 036: preserves historical verification void audit rows while blocking every new status transition.';

COMMIT;

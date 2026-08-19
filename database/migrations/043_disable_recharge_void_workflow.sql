-- Recharge void applications are retired. Historical approved/rejected/voided
-- rows remain readable, but no new recharge order may enter or change a void
-- lifecycle. Original PENDING/APPROVED/REJECTED review remains unchanged.

BEGIN;

DO $$
BEGIN
  IF TO_REGPROCEDURE('public.request_order_void(character varying,bigint,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 026 must be executed before migration 043';
  END IF;
END;
$$;

LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_reject_recharge_void_transition
  ON public.recharge_records;

-- Pending void requests cannot remain in a queue that no longer exists.
-- Preserve the requester, request note and request time; record a system
-- closure without changing the original approved recharge or customer balance.
UPDATE public.recharge_records
   SET void_request_status = 'REJECTED',
       void_reviewed_by_account_id = void_requested_by_account_id,
       void_reviewed_at = NOW(),
       void_review_note = '系统关闭：充值作废功能已停用；原充值单和客户次数保持不变。',
       updated_at = NOW()
 WHERE void_request_status = 'PENDING';

ALTER TABLE public.recharge_records
  DROP CONSTRAINT IF EXISTS recharge_records_void_disabled_check;

ALTER TABLE public.recharge_records
  ADD CONSTRAINT recharge_records_void_disabled_check
  CHECK (void_request_status <> 'PENDING');

CREATE OR REPLACE FUNCTION public.reject_recharge_void_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.void_request_status <> 'NONE' OR NEW.record_status = 'VOIDED' THEN
      RAISE EXCEPTION 'recharge orders cannot enter a void lifecycle'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.void_request_status IS DISTINCT FROM OLD.void_request_status THEN
    RAISE EXCEPTION 'recharge order void status is immutable because the void workflow is disabled'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.record_status IS DISTINCT FROM OLD.record_status
     AND NEW.record_status = 'VOIDED' THEN
    RAISE EXCEPTION 'recharge orders cannot transition to VOIDED because the void workflow is disabled'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reject_recharge_void_transition
BEFORE INSERT OR UPDATE OF void_request_status, record_status ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.reject_recharge_void_transition();

-- Keep the public signature so stale callers receive a deterministic business
-- error instead of a missing-function error. The old implementation is kept
-- in migration history; migration 043 is now the database authority.
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
BEGIN
  RAISE EXCEPTION 'order void applications are disabled; historical records are read-only'
    USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.request_order_void(VARCHAR, BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_recharge_void_transition() FROM PUBLIC;

COMMENT ON FUNCTION public.request_order_void(VARCHAR, BIGINT, BIGINT, TEXT) IS
  'Migration 043: recharge and verification void applications are disabled; historical rows remain read-only.';
COMMENT ON FUNCTION public.reject_recharge_void_transition() IS
  'Migration 043: preserves historical recharge void audit rows while blocking every new status transition.';

COMMIT;

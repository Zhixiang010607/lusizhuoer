BEGIN;

-- A void is a terminal state of the original verification record. It must
-- never be represented by inserting a second verification record.
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.record_status_history IN SHARE ROW EXCLUSIVE MODE;

-- Old prototype rows with verification_type = 'VOID' do not identify the
-- original verification row, so silently converting them would corrupt the
-- audit trail and could refund the wrong customer. Reconcile them first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.verification_records
    WHERE verification_type = 'VOID'
  ) THEN
    RAISE EXCEPTION
      'legacy VOID verification rows exist; link each request to its original verification row before running migration 022';
  END IF;
END;
$$;

ALTER TABLE public.verification_records
  ADD COLUMN IF NOT EXISTS void_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS voided_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_verification_type_check,
  DROP CONSTRAINT IF EXISTS verification_records_record_status_check,
  DROP CONSTRAINT IF EXISTS verification_records_unit_count_check,
  DROP CONSTRAINT IF EXISTS verification_records_void_state_check;

ALTER TABLE public.verification_records
  ADD CONSTRAINT verification_records_verification_type_check
    CHECK (verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')),
  ADD CONSTRAINT verification_records_record_status_check
    CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED', 'VOIDED')),
  ADD CONSTRAINT verification_records_unit_count_check
    CHECK (unit_count = 1),
  ADD CONSTRAINT verification_records_void_state_check
    CHECK (
      (record_status = 'VOIDED' AND voided_by_account_id IS NOT NULL AND voided_at IS NOT NULL)
      OR
      (record_status <> 'VOIDED' AND voided_by_account_id IS NULL AND voided_at IS NULL AND void_note = '')
    );

ALTER TABLE public.record_status_history
  DROP CONSTRAINT IF EXISTS record_status_history_current_status_check;

ALTER TABLE public.record_status_history
  ADD CONSTRAINT record_status_history_current_status_check
    CHECK (current_status IN ('PENDING', 'APPROVED', 'REJECTED', 'VOIDED'));

CREATE OR REPLACE FUNCTION public.validate_verification_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.record_status = 'VOIDED' THEN
      RAISE EXCEPTION 'a verification cannot be created in VOIDED status'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    IF OLD.record_status = 'PENDING'
       AND NEW.record_status NOT IN ('APPROVED', 'REJECTED') THEN
      RAISE EXCEPTION 'invalid verification transition: % -> %', OLD.record_status, NEW.record_status
        USING ERRCODE = '23514';
    ELSIF OLD.record_status = 'APPROVED'
          AND NEW.record_status <> 'VOIDED' THEN
      RAISE EXCEPTION 'invalid verification transition: % -> %', OLD.record_status, NEW.record_status
        USING ERRCODE = '23514';
    ELSIF OLD.record_status IN ('REJECTED', 'VOIDED') THEN
      RAISE EXCEPTION 'verification status % is terminal', OLD.record_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_verification_status_transition
ON public.verification_records;
CREATE TRIGGER trg_validate_verification_status_transition
BEFORE INSERT OR UPDATE OF record_status
ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.validate_verification_status_transition();

-- Idempotent and concurrency-safe. Only the first APPROVED -> VOIDED update
-- fires the balance refresh trigger. A retry sees VOIDED and returns the same
-- row without restoring the unit a second time.
CREATE OR REPLACE FUNCTION public.void_verification_record(
  p_verification_id BIGINT,
  p_actor_account_id BIGINT,
  p_void_note TEXT DEFAULT ''
)
RETURNS public.verification_records
LANGUAGE plpgsql
AS $$
DECLARE
  current_record public.verification_records%ROWTYPE;
BEGIN
  SELECT *
  INTO current_record
  FROM public.verification_records
  WHERE id = p_verification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification record % does not exist', p_verification_id
      USING ERRCODE = 'P0002';
  END IF;

  IF current_record.record_status = 'VOIDED' THEN
    RETURN current_record;
  END IF;

  IF current_record.record_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'only an APPROVED verification can be voided; current status is %',
      current_record.record_status
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.verification_records
  SET record_status = 'VOIDED',
      void_note = COALESCE(p_void_note, ''),
      voided_by_account_id = p_actor_account_id,
      voided_at = NOW()
  WHERE id = p_verification_id
  RETURNING * INTO current_record;

  RETURN current_record;
END;
$$;

COMMENT ON FUNCTION public.void_verification_record(BIGINT, BIGINT, TEXT) IS
  'Voids the original approved verification. NORMAL/SUPPLEMENT restore one consumed unit through the balance refresh trigger; EXPERIENCE restores zero units.';

REVOKE ALL ON FUNCTION public.void_verification_record(BIGINT, BIGINT, TEXT) FROM PUBLIC;

-- Keep status-history actor/note accurate for the VOIDED transition while
-- retaining the existing behaviour for review transitions and recharges.
CREATE OR REPLACE FUNCTION public.write_order_status_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_type VARCHAR(16);
  changed_by BIGINT;
  changed_note TEXT;
BEGIN
  order_type = CASE TG_TABLE_NAME WHEN 'recharge_records' THEN 'RECHARGE' ELSE 'VERIFICATION' END;

  IF TG_TABLE_NAME = 'verification_records' AND NEW.record_status = 'VOIDED' THEN
    changed_by = NEW.voided_by_account_id;
    changed_note = COALESCE(NEW.void_note, '');
  ELSE
    changed_by = COALESCE(NEW.reviewed_by_account_id, NEW.submitted_by_account_id);
    changed_note = COALESCE(NULLIF(NEW.review_note, ''), NEW.message, '');
  END IF;

  IF TG_OP = 'INSERT' OR NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    INSERT INTO public.record_status_history
      (record_type, record_id, previous_status, current_status, changed_by_account_id, change_note)
    VALUES
      (order_type, NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.record_status END,
       NEW.record_status, changed_by, changed_note);
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;

-- Transaction workflow states for recharge and verification records.
-- Run after migrations 006 and 007.  All SQL text is ASCII-only.

BEGIN;

-- Master records use ACTIVE or ARCHIVED.  Transaction records use their own
-- workflow state.  A recharge becomes usable when APPROVED and is deducted only
-- after a verification is APPROVED.
ALTER TABLE public.recharge_records
  ADD COLUMN IF NOT EXISTS record_status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
    CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.verification_records
  ADD COLUMN IF NOT EXISTS record_status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
    CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  ADD COLUMN IF NOT EXISTS verification_tag VARCHAR(24) NOT NULL DEFAULT 'NORMAL'
    CHECK (verification_tag IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')),
  ADD COLUMN IF NOT EXISTS face_status VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (face_status IN ('NOT_STARTED', 'PASSED', 'FAILED', 'ERROR')),
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Preserve the status already present in legacy data while moving all new
-- application code to record_status.
UPDATE public.recharge_records
SET record_status = CASE payment_status
  WHEN 'PAID' THEN 'APPROVED'
  WHEN 'REJECTED' THEN 'REJECTED'
  WHEN 'VOID' THEN 'REJECTED'
  ELSE 'PENDING'
END
WHERE record_status = 'PENDING';

UPDATE public.verification_records
SET record_status = CASE verification_status
  WHEN 'SUCCESS' THEN 'APPROVED'
  WHEN 'FAILED' THEN 'REJECTED'
  WHEN 'VOID' THEN 'REJECTED'
  ELSE 'PENDING'
END,
face_status = CASE verification_status
  WHEN 'SUCCESS' THEN 'PASSED'
  WHEN 'FAILED' THEN 'FAILED'
  ELSE face_status
END
WHERE record_status = 'PENDING' AND face_status = 'NOT_STARTED';

CREATE INDEX IF NOT EXISTS idx_recharge_record_status_time
  ON public.recharge_records (record_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_record_status_time
  ON public.verification_records (record_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_tag_time
  ON public.verification_records (verification_tag, created_at DESC);

-- Existing approved supplement-review records are retained as SUPPLEMENT.
UPDATE public.verification_records v
SET verification_tag = 'SUPPLEMENT'
WHERE EXISTS (
  SELECT 1
  FROM public.verification_review_requests r
  WHERE r.verification_id = v.id
    AND r.request_type = 'SUPPLEMENT'
    AND r.request_status = 'APPROVED'
)
  AND v.verification_tag = 'NORMAL';

-- This table records every lifecycle change.  It is used by the standalone
-- recharge and verification detail pages and is never overwritten.
CREATE TABLE IF NOT EXISTS public.record_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_type VARCHAR(16) NOT NULL CHECK (record_type IN ('recharge', 'verification')),
  record_id BIGINT NOT NULL,
  previous_status VARCHAR(24),
  current_status VARCHAR(24) NOT NULL,
  changed_by BIGINT REFERENCES public.staff_accounts(id),
  change_note TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_record_status_history_lookup
  ON public.record_status_history (record_type, record_id, changed_at DESC);

CREATE OR REPLACE FUNCTION public.log_recharge_record_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    INSERT INTO public.record_status_history
      (record_type, record_id, previous_status, current_status, changed_by, change_note)
    VALUES
      ('recharge', NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.record_status END,
       NEW.record_status, COALESCE(NEW.voided_by, NEW.created_by), NEW.note);
    NEW.status_changed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_verification_record_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    INSERT INTO public.record_status_history
      (record_type, record_id, previous_status, current_status, changed_by, change_note)
    VALUES
      ('verification', NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.record_status END,
       NEW.record_status, COALESCE(NEW.voided_by, NEW.verified_by), NEW.note);
    NEW.status_changed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_recharge_record_status ON public.recharge_records;
CREATE TRIGGER trg_log_recharge_record_status
BEFORE INSERT OR UPDATE OF record_status ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.log_recharge_record_status();

DROP TRIGGER IF EXISTS trg_log_verification_record_status ON public.verification_records;
CREATE TRIGGER trg_log_verification_record_status
BEFORE INSERT OR UPDATE OF record_status ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.log_verification_record_status();

INSERT INTO public.record_status_history
  (record_type, record_id, previous_status, current_status, changed_by, changed_at)
SELECT 'recharge', r.id, NULL, r.record_status, r.created_by, r.created_at
FROM public.recharge_records r
WHERE NOT EXISTS (
  SELECT 1 FROM public.record_status_history h
  WHERE h.record_type = 'recharge' AND h.record_id = r.id
);

INSERT INTO public.record_status_history
  (record_type, record_id, previous_status, current_status, changed_by, changed_at)
SELECT 'verification', v.id, NULL, v.record_status, v.verified_by, v.created_at
FROM public.verification_records v
WHERE NOT EXISTS (
  SELECT 1 FROM public.record_status_history h
  WHERE h.record_type = 'verification' AND h.record_id = v.id
);

-- A recharge is one record with only PENDING, APPROVED, and REJECTED states.
-- The legacy recharge_void_requests table is not used by the new workflow.
-- A void is performed by changing the original recharge record to REJECTED.
CREATE OR REPLACE FUNCTION public.validate_recharge_record_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    IF NOT (
      (OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED', 'REJECTED'))
      OR (OLD.record_status = 'APPROVED' AND NEW.record_status = 'REJECTED')
    ) THEN
      RAISE EXCEPTION 'invalid recharge status transition';
    END IF;
  END IF;
  NEW.payment_status = CASE NEW.record_status
    WHEN 'PENDING' THEN 'PENDING'
    WHEN 'APPROVED' THEN 'PAID'
    WHEN 'REJECTED' THEN 'REJECTED'
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_recharge_void_workflow ON public.recharge_void_requests;
DROP FUNCTION IF EXISTS public.sync_recharge_void_workflow();
DROP TRIGGER IF EXISTS trg_validate_recharge_record_transition ON public.recharge_records;
CREATE TRIGGER trg_validate_recharge_record_transition
BEFORE INSERT OR UPDATE OF record_status ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.validate_recharge_record_transition();

-- A verification is one record with only PENDING, APPROVED, and REJECTED
-- states.  Normal successful face recognition writes APPROVED directly.
CREATE OR REPLACE FUNCTION public.validate_verification_record_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    IF NOT (
      (OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED', 'REJECTED'))
      OR (OLD.record_status = 'APPROVED' AND NEW.record_status = 'REJECTED')
    ) THEN
      RAISE EXCEPTION 'invalid verification status transition';
    END IF;
  END IF;
  NEW.verification_status = CASE NEW.record_status
    WHEN 'PENDING' THEN 'PENDING'
    WHEN 'APPROVED' THEN 'SUCCESS'
    WHEN 'REJECTED' THEN 'FAILED'
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_verification_review_workflow ON public.verification_review_requests;
DROP FUNCTION IF EXISTS public.sync_verification_review_workflow();
DROP TRIGGER IF EXISTS trg_validate_verification_record_transition ON public.verification_records;
CREATE TRIGGER trg_validate_verification_record_transition
BEFORE INSERT OR UPDATE OF record_status ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.validate_verification_record_transition();

ALTER TABLE public.record_status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS record_status_history_scoped_read ON public.record_status_history;
CREATE POLICY record_status_history_scoped_read
ON public.record_status_history
FOR SELECT TO authenticated
USING (
  public.current_staff_role() = 'hq'
  OR EXISTS (
    SELECT 1 FROM public.recharge_records r
    WHERE record_status_history.record_type = 'recharge'
      AND r.id = record_status_history.record_id
      AND (public.has_store_scope(r.store_id) OR r.teacher_id = public.current_teacher_id())
  )
  OR EXISTS (
    SELECT 1 FROM public.verification_records v
    WHERE record_status_history.record_type = 'verification'
      AND v.id = record_status_history.record_id
      AND (public.has_store_scope(v.store_id) OR v.teacher_id = public.current_teacher_id())
  )
);

COMMIT;

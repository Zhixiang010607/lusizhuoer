BEGIN;

-- One business order owns both its original review and (optionally) one void
-- review.  A void request does not change record_status and therefore cannot
-- change a customer balance before it is approved.
LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.recharge_records
  ADD COLUMN IF NOT EXISTS void_request_status VARCHAR(16) NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS void_requested_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  ADD COLUMN IF NOT EXISTS void_request_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS void_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reviewed_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  ADD COLUMN IF NOT EXISTS void_review_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS void_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

ALTER TABLE public.verification_records
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64),
  ADD COLUMN IF NOT EXISTS void_request_status VARCHAR(16) NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS void_requested_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  ADD COLUMN IF NOT EXISTS void_request_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS void_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reviewed_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  ADD COLUMN IF NOT EXISTS void_review_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS void_reviewed_at TIMESTAMPTZ;

ALTER TABLE public.recharge_records
  DROP CONSTRAINT IF EXISTS recharge_records_record_status_check,
  DROP CONSTRAINT IF EXISTS recharge_records_void_request_state_check;

ALTER TABLE public.recharge_records
  ADD CONSTRAINT recharge_records_record_status_check
    CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED', 'VOIDED')),
  ADD CONSTRAINT recharge_records_void_request_state_check CHECK (
    (void_request_status = 'NONE'
      AND void_requested_by_account_id IS NULL AND void_requested_at IS NULL
      AND void_request_note = '' AND void_reviewed_by_account_id IS NULL
      AND void_reviewed_at IS NULL AND void_review_note = '')
    OR
    (void_request_status = 'PENDING'
      AND void_requested_by_account_id IS NOT NULL AND void_requested_at IS NOT NULL
      AND BTRIM(void_request_note) <> '' AND void_reviewed_by_account_id IS NULL
      AND void_reviewed_at IS NULL AND void_review_note = '' AND record_status = 'APPROVED')
    OR
    (void_request_status = 'REJECTED'
      AND void_requested_by_account_id IS NOT NULL AND void_requested_at IS NOT NULL
      AND BTRIM(void_request_note) <> '' AND void_reviewed_by_account_id IS NOT NULL
      AND void_reviewed_at IS NOT NULL
      AND record_status = 'APPROVED')
    OR
    (void_request_status = 'APPROVED'
      AND void_requested_by_account_id IS NOT NULL AND void_requested_at IS NOT NULL
      AND BTRIM(void_request_note) <> '' AND void_reviewed_by_account_id IS NOT NULL
      AND void_reviewed_at IS NOT NULL
      AND record_status = 'VOIDED' AND voided_by_account_id IS NOT NULL AND voided_at IS NOT NULL)
  );

ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_void_request_state_check;

ALTER TABLE public.verification_records
  ADD CONSTRAINT verification_records_void_request_state_check CHECK (
    (void_request_status = 'NONE'
      AND void_requested_by_account_id IS NULL AND void_requested_at IS NULL
      AND void_request_note = '' AND void_reviewed_by_account_id IS NULL
      AND void_reviewed_at IS NULL AND void_review_note = '')
    OR
    (void_request_status = 'PENDING'
      AND void_requested_by_account_id IS NOT NULL AND void_requested_at IS NOT NULL
      AND BTRIM(void_request_note) <> '' AND void_reviewed_by_account_id IS NULL
      AND void_reviewed_at IS NULL AND void_review_note = '' AND record_status = 'APPROVED')
    OR
    (void_request_status = 'REJECTED'
      AND void_requested_by_account_id IS NOT NULL AND void_requested_at IS NOT NULL
      AND BTRIM(void_request_note) <> '' AND void_reviewed_by_account_id IS NOT NULL
      AND void_reviewed_at IS NOT NULL
      AND record_status = 'APPROVED')
    OR
    (void_request_status = 'APPROVED'
      AND void_requested_by_account_id IS NOT NULL AND void_requested_at IS NOT NULL
      AND BTRIM(void_request_note) <> '' AND void_reviewed_by_account_id IS NOT NULL
      AND void_reviewed_at IS NOT NULL
      AND record_status = 'VOIDED')
  );

-- Migration 008 installed a compatibility trigger which only allowed
-- APPROVED -> REJECTED for a recharge.  The canonical void workflow keeps the
-- original row and uses APPROVED -> VOIDED instead.  Keep payment_status in
-- sync for installations that still have that legacy compatibility column.
CREATE OR REPLACE FUNCTION public.validate_recharge_record_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    IF NOT (
      (OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED', 'REJECTED'))
      OR (OLD.record_status = 'APPROVED' AND NEW.record_status = 'VOIDED')
    ) THEN
      RAISE EXCEPTION 'invalid recharge status transition: % -> %',
        OLD.record_status, NEW.record_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.payment_status = CASE NEW.record_status
    WHEN 'PENDING' THEN 'PENDING'
    WHEN 'APPROVED' THEN 'PAID'
    WHEN 'REJECTED' THEN 'REJECTED'
    WHEN 'VOIDED' THEN 'REJECTED'
  END;
  NEW.status_changed_at = NOW();
  RETURN NEW;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_recharge_void_review_queue
  ON public.recharge_records (void_request_status, void_requested_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_verification_void_review_queue
  ON public.verification_records (void_request_status, void_requested_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_idempotency_key
  ON public.verification_records (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

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
  actor_role TEXT;
  actor_store_id BIGINT;
  current_status TEXT;
  current_void_status TEXT;
  current_store_id BIGINT;
  current_code TEXT;
BEGIN
  IF BTRIM(COALESCE(p_note, '')) = '' THEN
    RAISE EXCEPTION 'void request note is required' USING ERRCODE = '23514';
  END IF;
  IF LENGTH(p_note) > 1000 THEN
    RAISE EXCEPTION 'void request note is too long' USING ERRCODE = '22001';
  END IF;

  SELECT a.role_code, s.id
    INTO actor_role, actor_store_id
    FROM public.staff_accounts a
    LEFT JOIN public.stores s ON s.store_account_id = a.id AND s.store_status = 'ACTIVE'
   WHERE a.id = p_actor_account_id AND a.account_status = 'ACTIVE';
  IF actor_role <> 'store' OR actor_store_id IS NULL THEN
    RAISE EXCEPTION 'only an active bound store account can request a void' USING ERRCODE = '42501';
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' THEN
    SELECT r.record_status, r.void_request_status, r.store_id, r.recharge_code
      INTO current_status, current_void_status, current_store_id, current_code
      FROM public.recharge_records r WHERE r.id = p_record_id FOR UPDATE;
  ELSIF UPPER(p_record_type) = 'VERIFICATION' THEN
    SELECT v.record_status, v.void_request_status, v.store_id, v.verification_code
      INTO current_status, current_void_status, current_store_id, current_code
      FROM public.verification_records v WHERE v.id = p_record_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'unsupported record type' USING ERRCODE = '22023';
  END IF;

  IF current_code IS NULL THEN
    RAISE EXCEPTION 'order does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF current_store_id <> actor_store_id THEN
    RAISE EXCEPTION 'the order does not belong to this store' USING ERRCODE = '42501';
  END IF;
  IF current_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'only an approved order can request a void' USING ERRCODE = '23514';
  END IF;
  IF current_void_status <> 'NONE' THEN
    RAISE EXCEPTION 'this order already has a void review lifecycle' USING ERRCODE = '23514';
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' THEN
    UPDATE public.recharge_records
       SET void_request_status = 'PENDING', void_requested_by_account_id = p_actor_account_id,
           void_request_note = BTRIM(p_note), void_requested_at = NOW(), updated_at = NOW()
     WHERE id = p_record_id;
  ELSE
    UPDATE public.verification_records
       SET void_request_status = 'PENDING', void_requested_by_account_id = p_actor_account_id,
           void_request_note = BTRIM(p_note), void_requested_at = NOW(), updated_at = NOW()
     WHERE id = p_record_id;
  END IF;

  RETURN QUERY SELECT p_record_id, current_code, current_status, 'PENDING'::TEXT, NOW();
END;
$$;

CREATE OR REPLACE FUNCTION public.review_order_application(
  p_record_type VARCHAR,
  p_record_id BIGINT,
  p_actor_account_id BIGINT,
  p_decision VARCHAR,
  p_note TEXT
)
RETURNS TABLE(record_id BIGINT, record_code TEXT, record_status TEXT,
              void_request_status TEXT, reviewed_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  actor_role TEXT;
  decision TEXT := UPPER(COALESCE(p_decision, ''));
  current_status TEXT;
  current_void_status TEXT;
  current_code TEXT;
  recharge_customer_id BIGINT;
  recharge_product_id BIGINT;
  recharge_units INTEGER;
  current_recharge_type TEXT;
  current_remaining BIGINT;
BEGIN
  SELECT role_code INTO actor_role
    FROM public.staff_accounts
   WHERE id = p_actor_account_id AND account_status = 'ACTIVE';
  IF actor_role NOT IN ('hq', 'operation') THEN
    RAISE EXCEPTION 'only headquarters or operations can review orders' USING ERRCODE = '42501';
  END IF;
  IF decision NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'decision must be APPROVED or REJECTED' USING ERRCODE = '22023';
  END IF;
  IF LENGTH(COALESCE(p_note, '')) > 1000 THEN
    RAISE EXCEPTION 'review note is too long' USING ERRCODE = '22001';
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' THEN
    SELECT record_status, void_request_status, recharge_code, customer_id, product_id,
           unit_count, recharge_type
      INTO current_status, current_void_status, current_code,
           recharge_customer_id, recharge_product_id, recharge_units, current_recharge_type
      FROM public.recharge_records WHERE id = p_record_id FOR UPDATE;
  ELSIF UPPER(p_record_type) = 'VERIFICATION' THEN
    SELECT record_status, void_request_status, verification_code
      INTO current_status, current_void_status, current_code
      FROM public.verification_records WHERE id = p_record_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'unsupported record type' USING ERRCODE = '22023';
  END IF;
  IF current_code IS NULL THEN RAISE EXCEPTION 'order does not exist' USING ERRCODE = 'P0002'; END IF;

  IF current_void_status = 'PENDING' THEN
    IF UPPER(p_record_type) = 'RECHARGE' THEN
      IF decision = 'APPROVED' THEN
        -- Serialize all balance-changing decisions for this customer. This uses
        -- the same customer row lock as refresh_customer_balance(), so two
        -- concurrent approvals cannot both rely on the same available units.
        PERFORM 1
          FROM public.customers
         WHERE id = recharge_customer_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'customer does not exist' USING ERRCODE = 'P0002';
        END IF;

        SELECT
          COALESCE((
            SELECT SUM(CASE r.recharge_type WHEN 'NEW' THEN r.unit_count ELSE -r.unit_count END)
              FROM public.recharge_records r
             WHERE r.customer_id = recharge_customer_id
               AND r.product_id = recharge_product_id
               AND r.record_status = 'APPROVED'
          ), 0)
          - COALESCE((
            SELECT SUM(v.unit_count)
              FROM public.verification_records v
             WHERE v.customer_id = recharge_customer_id
               AND v.product_id = recharge_product_id
               AND v.record_status = 'APPROVED'
               AND v.verification_type IN ('NORMAL', 'SUPPLEMENT')
          ), 0)
          INTO current_remaining;

        IF (current_remaining - (
          CASE current_recharge_type
            WHEN 'NEW' THEN recharge_units
            ELSE -recharge_units
          END
        )) < 0 THEN
          RAISE EXCEPTION 'cannot approve recharge void: customer product balance would become negative'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      UPDATE public.recharge_records
         SET void_request_status = decision,
             void_reviewed_by_account_id = p_actor_account_id,
             void_review_note = BTRIM(COALESCE(p_note, '')), void_reviewed_at = NOW(),
             record_status = CASE WHEN decision = 'APPROVED' THEN 'VOIDED' ELSE 'APPROVED' END,
             voided_by_account_id = CASE WHEN decision = 'APPROVED' THEN p_actor_account_id ELSE NULL END,
             voided_at = CASE WHEN decision = 'APPROVED' THEN NOW() ELSE NULL END,
             updated_at = NOW()
       WHERE id = p_record_id;
    ELSE
      UPDATE public.verification_records
         SET void_request_status = decision,
             void_reviewed_by_account_id = p_actor_account_id,
             void_review_note = BTRIM(COALESCE(p_note, '')), void_reviewed_at = NOW(),
             record_status = CASE WHEN decision = 'APPROVED' THEN 'VOIDED' ELSE 'APPROVED' END,
             void_note = CASE WHEN decision = 'APPROVED' THEN void_request_note ELSE '' END,
             voided_by_account_id = CASE WHEN decision = 'APPROVED' THEN p_actor_account_id ELSE NULL END,
             voided_at = CASE WHEN decision = 'APPROVED' THEN NOW() ELSE NULL END,
             updated_at = NOW()
       WHERE id = p_record_id;
    END IF;
    current_status := CASE WHEN decision = 'APPROVED' THEN 'VOIDED' ELSE 'APPROVED' END;
    current_void_status := decision;
  ELSE
    IF current_void_status <> 'NONE' OR current_status <> 'PENDING' THEN
      RAISE EXCEPTION 'this application is no longer pending' USING ERRCODE = '23514';
    END IF;
    IF UPPER(p_record_type) = 'RECHARGE' THEN
      UPDATE public.recharge_records
         SET record_status = decision, reviewed_by_account_id = p_actor_account_id,
             reviewed_at = NOW(), review_note = BTRIM(p_note), updated_at = NOW()
       WHERE id = p_record_id;
    ELSE
      UPDATE public.verification_records
         SET record_status = decision, reviewed_by_account_id = p_actor_account_id,
             reviewed_at = NOW(), review_note = BTRIM(p_note), updated_at = NOW()
       WHERE id = p_record_id;
    END IF;
    current_status := decision;
  END IF;

  RETURN QUERY SELECT p_record_id, current_code, current_status, current_void_status, NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.request_order_void(VARCHAR, BIGINT, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_order_application(VARCHAR, BIGINT, BIGINT, VARCHAR, TEXT) FROM PUBLIC;

COMMIT;

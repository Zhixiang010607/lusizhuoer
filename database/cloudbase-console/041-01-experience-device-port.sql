-- CloudBase SQL editor migration 041, part 1 / 2: virtual port and status guard.
BEGIN;

CREATE TABLE IF NOT EXISTS public.device_signal_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verification_id BIGINT NOT NULL UNIQUE
    REFERENCES public.verification_records(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  customer_id BIGINT NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  teacher_id BIGINT NOT NULL REFERENCES public.teachers(id) ON DELETE RESTRICT,
  signal_type VARCHAR(32) NOT NULL DEFAULT 'ENABLE_PROJECT_ACCESS'
    CHECK (signal_type = 'ENABLE_PROJECT_ACCESS'),
  signal_status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (signal_status IN ('PENDING', 'SENT', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_signal_outbox_pending
  ON public.device_signal_outbox(signal_status, created_at, id);

COMMENT ON TABLE public.device_signal_outbox IS
  'Virtual device port. A physical-device gateway consumes one idempotent ENABLE_PROJECT_ACCESS signal per approved NORMAL or EXPERIENCE verification.';

REVOKE ALL ON TABLE public.device_signal_outbox FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.guard_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'recharge_records' THEN
      IF NEW.recharge_type <> 'NEW' THEN
        RAISE EXCEPTION 'a void request must reuse the original recharge order'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a recharge application must start as PENDING'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'verification_records' THEN
      IF NEW.verification_type IN ('NORMAL', 'EXPERIENCE')
         AND NEW.record_status <> 'APPROVED' THEN
        RAISE EXCEPTION 'a NORMAL or EXPERIENCE verification must be effective immediately'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.verification_type = 'SUPPLEMENT'
         AND NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a historical SUPPLEMENT verification must start as PENDING'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.record_status IS NOT DISTINCT FROM OLD.record_status THEN
    RETURN NEW;
  END IF;

  IF OLD.record_status = 'PENDING'
     AND NEW.record_status IN ('APPROVED', 'REJECTED') THEN
    RETURN NEW;
  END IF;

  IF OLD.record_status = 'APPROVED'
     AND NEW.record_status = 'VOIDED'
     AND NEW.void_request_status = 'APPROVED' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid order status transition: % -> %',
    OLD.record_status, NEW.record_status
    USING ERRCODE = '23514';
END;
$$;
COMMIT;

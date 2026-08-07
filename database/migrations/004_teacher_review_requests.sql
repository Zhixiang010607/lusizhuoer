-- Teachers may request review only for their own work. Store fields remain for audit linkage and must not be shown in the teacher UI.
CREATE TABLE IF NOT EXISTS public.verification_review_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_code VARCHAR(32) NOT NULL UNIQUE,
  verification_id BIGINT NOT NULL REFERENCES public.verification_records(id),
  teacher_id BIGINT NOT NULL REFERENCES public.teachers(id),
  request_type VARCHAR(16) NOT NULL CHECK (request_type IN ('SUPPLEMENT', 'VOID')),
  request_reason TEXT NOT NULL,
  request_status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (request_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES public.staff_accounts(id),
  reviewer_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_verification_review_teacher ON public.verification_review_requests (teacher_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_verification_review_per_teacher_record
  ON public.verification_review_requests (verification_id, teacher_id) WHERE request_status = 'PENDING';

CREATE TABLE IF NOT EXISTS public.recharge_void_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_code VARCHAR(32) NOT NULL UNIQUE,
  recharge_id BIGINT NOT NULL REFERENCES public.recharge_records(id),
  teacher_id BIGINT NOT NULL REFERENCES public.teachers(id),
  request_reason TEXT NOT NULL,
  request_status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (request_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES public.staff_accounts(id),
  reviewer_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_recharge_void_teacher ON public.recharge_void_requests (teacher_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_recharge_void_per_teacher_record
  ON public.recharge_void_requests (recharge_id, teacher_id) WHERE request_status = 'PENDING';

ALTER TABLE public.verification_review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recharge_void_requests ENABLE ROW LEVEL SECURITY;

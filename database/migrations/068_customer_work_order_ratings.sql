BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'migration 068 requires the CloudBase service_role';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.verification_customer_ratings (
  id BIGSERIAL PRIMARY KEY,
  verification_id BIGINT NOT NULL
    REFERENCES public.verification_records(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL
    REFERENCES public.stores(id) ON DELETE RESTRICT,
  teacher_id BIGINT
    REFERENCES public.teachers(id) ON DELETE RESTRICT,
  issued_by_account_id BIGINT NOT NULL
    REFERENCES public.staff_accounts(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1
    CHECK (token_version BETWEEN 1 AND 999999999),
  rating_status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (rating_status IN ('OPEN', 'SUBMITTED')),
  store_environment_score SMALLINT
    CHECK (store_environment_score BETWEEN 1 AND 5),
  teacher_service_score SMALLINT
    CHECK (teacher_service_score BETWEEN 1 AND 5),
  overall_experience_score SMALLINT
    CHECK (overall_experience_score BETWEEN 1 AND 5),
  customer_comment TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_verification_customer_ratings_verification UNIQUE (verification_id),
  CONSTRAINT uq_verification_customer_ratings_token UNIQUE (token_hash),
  CONSTRAINT ck_verification_customer_ratings_token_hash
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_verification_customer_ratings_comment
    CHECK (customer_comment IS NULL OR char_length(customer_comment) <= 500),
  CONSTRAINT ck_verification_customer_ratings_submission
    CHECK (
      (rating_status = 'OPEN'
        AND store_environment_score IS NULL
        AND teacher_service_score IS NULL
        AND overall_experience_score IS NULL
        AND customer_comment IS NULL
        AND submitted_at IS NULL)
      OR
      (rating_status = 'SUBMITTED'
        AND store_environment_score IS NOT NULL
        AND overall_experience_score IS NOT NULL
        AND (
          (teacher_id IS NULL AND teacher_service_score IS NULL)
          OR (teacher_id IS NOT NULL AND teacher_service_score IS NOT NULL)
        )
        AND submitted_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_verification_customer_ratings_store
  ON public.verification_customer_ratings (store_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_customer_ratings_teacher
  ON public.verification_customer_ratings (teacher_id, issued_at DESC)
  WHERE teacher_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verification_customer_ratings_status
  ON public.verification_customer_ratings (rating_status, issued_at DESC);

CREATE OR REPLACE FUNCTION public.enforce_verification_customer_rating_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  work_order public.verification_records%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.rating_status = 'SUBMITTED' OR OLD.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'submitted customer ratings are immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.verification_id IS DISTINCT FROM OLD.verification_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
       OR NEW.issued_by_account_id IS DISTINCT FROM OLD.issued_by_account_id
       OR NEW.token_version IS DISTINCT FROM OLD.token_version
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'customer rating work-order binding is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT verification.*
    INTO work_order
    FROM public.verification_records AS verification
   WHERE verification.id = NEW.verification_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR work_order.verification_type NOT IN ('NORMAL', 'EXPERIENCE')
     OR work_order.record_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'customer ratings require a completed normal or experience verification'
      USING ERRCODE = '23514';
  END IF;

  NEW.store_id := work_order.store_id;
  NEW.teacher_id := work_order.teacher_id;
  NEW.updated_at := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_verification_customer_rating_binding
  ON public.verification_customer_ratings;
CREATE TRIGGER trg_enforce_verification_customer_rating_binding
BEFORE INSERT OR UPDATE ON public.verification_customer_ratings
FOR EACH ROW EXECUTE FUNCTION public.enforce_verification_customer_rating_binding();

CREATE OR REPLACE FUNCTION public.prevent_verification_customer_rating_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'customer ratings are immutable audit evidence and cannot be deleted'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_verification_customer_rating_delete
  ON public.verification_customer_ratings;
CREATE TRIGGER trg_prevent_verification_customer_rating_delete
BEFORE DELETE ON public.verification_customer_ratings
FOR EACH ROW EXECUTE FUNCTION public.prevent_verification_customer_rating_delete();

ALTER TABLE public.verification_customer_ratings ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.verification_customer_ratings
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.verification_customer_ratings_id_seq
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_verification_customer_rating_binding()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_verification_customer_rating_delete()
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.verification_customer_ratings TO service_role;
GRANT ALL PRIVILEGES ON SEQUENCE public.verification_customer_ratings_id_seq TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_verification_customer_rating_binding() TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_verification_customer_rating_delete() TO service_role;

COMMENT ON TABLE public.verification_customer_ratings IS
  'Migration 068: one immutable customer rating per completed normal or experience verification; public links store only SHA-256 token hashes.';
COMMENT ON COLUMN public.verification_customer_ratings.teacher_service_score IS
  'Required when the bound verification has an assigned teacher; otherwise omitted.';
COMMENT ON COLUMN public.verification_customer_ratings.token_version IS
  'Version included in the server-signed opaque public token; plaintext bearer tokens are never stored.';

COMMIT;

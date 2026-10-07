BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.verification_customer_ratings') IS NULL THEN
    RAISE EXCEPTION 'migration 070 requires migration 068';
  END IF;
END;
$$;

ALTER TABLE public.verification_customer_ratings
  ADD COLUMN IF NOT EXISTS rating_form_version SMALLINT;

UPDATE public.verification_customer_ratings
   SET rating_form_version = 1
 WHERE rating_form_version IS NULL;

ALTER TABLE public.verification_customer_ratings
  ALTER COLUMN rating_form_version SET DEFAULT 2,
  ALTER COLUMN rating_form_version SET NOT NULL;

ALTER TABLE public.verification_customer_ratings
  DROP CONSTRAINT IF EXISTS ck_verification_customer_ratings_form_version;
ALTER TABLE public.verification_customer_ratings
  ADD CONSTRAINT ck_verification_customer_ratings_form_version
  CHECK (rating_form_version IN (1, 2));

ALTER TABLE public.verification_customer_ratings
  DROP CONSTRAINT IF EXISTS ck_verification_customer_ratings_submission;
ALTER TABLE public.verification_customer_ratings
  ADD CONSTRAINT ck_verification_customer_ratings_submission
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
        teacher_service_score IS NOT NULL
        OR (
          rating_form_version = 1
          AND teacher_id IS NULL
          AND teacher_service_score IS NULL
        )
      )
      AND submitted_at IS NOT NULL)
  );

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
       OR NEW.rating_form_version IS DISTINCT FROM OLD.rating_form_version
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

REVOKE ALL ON FUNCTION public.enforce_verification_customer_rating_binding()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_verification_customer_rating_binding()
  TO service_role;

COMMENT ON COLUMN public.verification_customer_ratings.rating_form_version IS
  'Rating form contract: v1 preserves historical optional teacher scores; v2 always requires the second teacher-service score.';
COMMENT ON COLUMN public.verification_customer_ratings.teacher_service_score IS
  'Required for every new v2 rating, even when the work order has no assigned business teacher; historical submitted v1 rows remain unchanged.';

COMMIT;

-- Migration 054: only the logged-in teacher may gift EXPERIENCE verification.
-- The teacher account owns the quota; the selected customer is the 1:1 face
-- subject and both immutable receipt photos are customer photos.
BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.teacher_product_experience_quotas') IS NULL
     OR TO_REGCLASS('public.verification_photo_drafts') IS NULL
     OR TO_REGPROCEDURE(
       'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
     ) IS NULL THEN
    RAISE EXCEPTION 'migration 054 requires migrations through 049';
  END IF;
END;
$$;

-- New EXPERIENCE records use the same customer face subject as normal
-- verification. Historical teacher-face EXPERIENCE rows remain unchanged.
CREATE OR REPLACE FUNCTION public.enforce_verification_face_subject()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.face_subject_type <> 'CUSTOMER'
     OR NEW.face_subject_teacher_id IS NOT NULL THEN
    RAISE EXCEPTION 'verification requires its customer as the face subject'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_experience_verification_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verification_type = 'EXPERIENCE' AND (
    NOT EXISTS (
      SELECT 1 FROM public.teacher_experience_quota_usages AS usage
       WHERE usage.verification_id = NEW.id
         AND usage.teacher_id = NEW.teacher_id
         AND usage.product_id = NEW.product_id
         AND usage.unit_count = NEW.unit_count
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.verification_photos AS photo
       WHERE photo.verification_id = NEW.id AND photo.photo_slot = 0
         AND photo.photo_kind = 'PROFILE'
         AND photo.face_subject_type = 'CUSTOMER'
         AND photo.face_subject_teacher_id IS NULL
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.verification_photos AS photo
       WHERE photo.verification_id = NEW.id AND photo.photo_slot = 1
         AND photo.photo_kind = 'FACE'
         AND photo.face_subject_type = 'CUSTOMER'
         AND photo.face_subject_teacher_id IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'EXPERIENCE verification requires teacher quota usage and two customer face photos'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Remove the retired teacher-face EXPERIENCE write path. Historical rows and
-- their honest face_subject_type metadata are retained for read-only display.
DROP FUNCTION IF EXISTS public.create_experience_verification_with_teacher_face_photo(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR
);
DROP FUNCTION IF EXISTS public.insert_teacher_experience_verification(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR
);
DROP FUNCTION IF EXISTS public.find_teacher_experience_verification_replay(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR
);
DROP FUNCTION IF EXISTS public.bind_teacher_experience_face_photos(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, VARCHAR, TEXT
);
DROP FUNCTION IF EXISTS public.lock_active_teacher_experience_subjects(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT
);

CREATE OR REPLACE FUNCTION public.create_experience_verification_with_customer_face_photo(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT,
  p_product_id BIGINT, p_submitted_by_account_id BIGINT, p_message TEXT,
  p_face_request_id VARCHAR, p_face_evidence_token VARCHAR,
  p_idempotency_key VARCHAR
)
RETURNS TABLE(
  id BIGINT, verification_code TEXT, verification_type TEXT, store_id BIGINT,
  teacher_id BIGINT, customer_id BIGINT, product_id BIGINT, unit_count INTEGER,
  record_status TEXT, submitted_by_account_id BIGINT, submitted_at TIMESTAMPTZ,
  message TEXT, supplement_note TEXT, face_request_id TEXT,
  idempotency_key TEXT, created_now BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE existing_id BIGINT;
BEGIN
  IF BTRIM(COALESCE(p_idempotency_key, '')) = ''
     OR BTRIM(COALESCE(p_face_request_id, '')) = ''
     OR BTRIM(COALESCE(p_face_evidence_token, '')) = '' THEN
    RAISE EXCEPTION 'experience verification idempotency and customer face evidence are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));

  -- Database-side authority: the submitting account must be the active
  -- teacher whose quota is being consumed. Store/HQ accounts cannot call this
  -- path even if a stale browser or privileged API forwards teacher_id.
  PERFORM 1
    FROM public.staff_accounts AS account
    JOIN public.teachers AS teacher ON teacher.staff_account_id = account.id
   WHERE account.id = p_submitted_by_account_id
     AND account.role_code = 'teacher'
     AND account.account_status = 'ACTIVE'
     AND teacher.id = p_teacher_id
     AND teacher.teacher_status = 'ACTIVE'
   FOR SHARE OF account, teacher;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only the active bound teacher may create EXPERIENCE verification'
      USING ERRCODE = '42501';
  END IF;

  SELECT record.id INTO existing_id
    FROM public.verification_records AS record
   WHERE record.idempotency_key = p_idempotency_key
   LIMIT 1;

  IF existing_id IS NULL THEN
    PERFORM 1
      FROM public.teacher_product_experience_quotas AS quota
     WHERE quota.teacher_id = p_teacher_id
       AND quota.product_id = p_product_id
       AND quota.quota_status = 'ACTIVE'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'teacher has no active configured experience quota for this product'
        USING ERRCODE = '23514';
    END IF;

    PERFORM 1
      FROM public.verification_photo_drafts AS draft
     WHERE draft.evidence_token = p_face_evidence_token
       AND draft.store_id = p_store_id
       AND draft.customer_id = p_customer_id
       AND draft.submitted_by_account_id = p_submitted_by_account_id
       AND draft.face_request_id = p_face_request_id
       AND draft.face_subject_type = 'CUSTOMER'
       AND draft.face_subject_teacher_id IS NULL
       AND draft.consumed_at IS NULL
       AND draft.expires_at > CLOCK_TIMESTAMP()
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer face photo evidence is missing, expired, consumed, or belongs to another request'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public.create_verification_with_face_photo(
    'EXPERIENCE'::VARCHAR, p_store_id, p_teacher_id, p_customer_id,
    p_product_id, 'APPROVED'::VARCHAR, p_submitted_by_account_id,
    COALESCE(p_message, '')::TEXT, ''::TEXT, p_face_request_id,
    p_face_evidence_token, p_idempotency_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_experience_verification_with_customer_face_photo(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC;

COMMENT ON COLUMN public.verification_records.face_subject_type IS
  'CUSTOMER for all new verification evidence after migration 054; historical teacher-face EXPERIENCE rows retain TEACHER.';
COMMENT ON FUNCTION public.create_experience_verification_with_customer_face_photo(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR
) IS
  'Teacher-only EXPERIENCE write: binds the logged-in teacher quota while snapshotting the selected customer profile and live 1:1 face evidence.';

COMMIT;

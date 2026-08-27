-- Migration 064: every new NORMAL or EXPERIENCE verification must carry an
-- operator-selected unit count. The count is persisted in the idempotent
-- request, atomically checked against paid balance or teacher quota, and is
-- the authoritative count referenced by the device signal outbox.
BEGIN;

DO $$
BEGIN
  IF TO_REGPROCEDURE(
       'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
     ) IS NULL
     OR TO_REGPROCEDURE(
       'public.create_experience_verification_with_customer_face_photo(bigint,bigint,bigint,bigint,bigint,text,character varying,character varying,character varying)'
     ) IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_usages') IS NULL
     OR TO_REGCLASS('public.device_signal_outbox') IS NULL THEN
    RAISE EXCEPTION 'migration 064 prerequisites are missing; execute migrations through 063 first';
  END IF;
END;
$$;

LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.teacher_experience_quota_usages IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_unit_count_check;
ALTER TABLE public.verification_records
  ADD CONSTRAINT verification_records_unit_count_check
  CHECK (unit_count BETWEEN 1 AND 999);

ALTER TABLE public.teacher_experience_quota_usages
  DROP CONSTRAINT IF EXISTS teacher_experience_quota_usages_unit_count_check;
ALTER TABLE public.teacher_experience_quota_usages
  ADD CONSTRAINT teacher_experience_quota_usages_unit_count_check
  CHECK (unit_count BETWEEN 1 AND 999);

-- Keep the old signature present but fail closed. This creates a deliberate
-- short write outage for an old v97 runtime after SQL 064 is applied, instead
-- of silently continuing to create one-unit records.
CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo(
  p_verification_type VARCHAR,
  p_store_id BIGINT,
  p_teacher_id BIGINT,
  p_customer_id BIGINT,
  p_product_id BIGINT,
  p_record_status VARCHAR,
  p_submitted_by_account_id BIGINT,
  p_message TEXT,
  p_supplement_note TEXT,
  p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR,
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
BEGIN
  RAISE EXCEPTION 'verification unit count is required by migration 064'
    USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo(
  p_verification_type VARCHAR,
  p_store_id BIGINT,
  p_teacher_id BIGINT,
  p_customer_id BIGINT,
  p_product_id BIGINT,
  p_unit_count INTEGER,
  p_record_status VARCHAR,
  p_submitted_by_account_id BIGINT,
  p_message TEXT,
  p_supplement_note TEXT,
  p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR,
  p_idempotency_key VARCHAR
)
RETURNS TABLE(
  id BIGINT,
  verification_code TEXT,
  verification_type TEXT,
  store_id BIGINT,
  teacher_id BIGINT,
  customer_id BIGINT,
  product_id BIGINT,
  unit_count INTEGER,
  record_status TEXT,
  submitted_by_account_id BIGINT,
  submitted_at TIMESTAMPTZ,
  message TEXT,
  supplement_note TEXT,
  face_request_id TEXT,
  idempotency_key TEXT,
  created_now BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing_record public.verification_records%ROWTYPE;
  draft public.verification_photo_drafts%ROWTYPE;
  created_record public.verification_records%ROWTYPE;
  quota public.teacher_product_experience_quotas%ROWTYPE;
  usage public.teacher_experience_quota_usages%ROWTYPE;
  profile_object_ref TEXT;
  normalized_type TEXT := UPPER(BTRIM(COALESCE(p_verification_type, '')));
  normalized_status TEXT := UPPER(BTRIM(COALESCE(p_record_status, '')));
  effective_month DATE := public.teacher_experience_quota_month();
  quota_before INTEGER;
BEGIN
  IF normalized_type NOT IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE') THEN
    RAISE EXCEPTION 'unsupported verification type' USING ERRCODE = '22023';
  END IF;
  IF p_unit_count IS NULL OR p_unit_count < 1 OR p_unit_count > 999 THEN
    RAISE EXCEPTION 'verification unit count must be between 1 and 999'
      USING ERRCODE = '22023';
  END IF;
  IF normalized_status <> (CASE WHEN normalized_type = 'SUPPLEMENT' THEN 'PENDING' ELSE 'APPROVED' END) THEN
    RAISE EXCEPTION 'verification status does not match verification type'
      USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_face_evidence_token, '')) = '' THEN
    RAISE EXCEPTION 'face photo evidence is required' USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_face_request_id, '')) = '' THEN
    RAISE EXCEPTION 'face verification request id is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));
  SELECT record.* INTO existing_record
    FROM public.verification_records AS record
   WHERE record.idempotency_key = p_idempotency_key
   LIMIT 1;
  IF existing_record.id IS NOT NULL THEN
    PERFORM public.assert_matching_verification_idempotency(
      existing_record.id, normalized_type, p_store_id, p_teacher_id, p_customer_id,
      p_product_id, p_submitted_by_account_id, p_message, p_supplement_note,
      p_face_request_id, p_face_evidence_token
    );
    IF existing_record.unit_count IS DISTINCT FROM p_unit_count THEN
      RAISE EXCEPTION 'idempotency key belongs to a different verification unit count'
        USING ERRCODE = '23505';
    END IF;
    IF existing_record.verification_type = 'EXPERIENCE' AND NOT EXISTS (
      SELECT 1
        FROM public.teacher_experience_quota_usages AS quota_usage
       WHERE quota_usage.verification_id = existing_record.id
         AND quota_usage.unit_count = existing_record.unit_count
    ) THEN
      RAISE EXCEPTION 'experience verification is missing its teacher quota usage audit row'
        USING ERRCODE = '23514';
    END IF;
    IF existing_record.verification_type IN ('NORMAL', 'EXPERIENCE')
       AND existing_record.record_status = 'APPROVED' THEN
      INSERT INTO public.device_signal_outbox
        (verification_id, store_id, customer_id, product_id, teacher_id)
      VALUES
        (existing_record.id, existing_record.store_id, existing_record.customer_id,
         existing_record.product_id, existing_record.teacher_id)
      ON CONFLICT (verification_id) DO NOTHING;
    END IF;
    RETURN QUERY SELECT existing_record.id, existing_record.verification_code::TEXT,
      existing_record.verification_type::TEXT, existing_record.store_id,
      existing_record.teacher_id, existing_record.customer_id,
      existing_record.product_id, existing_record.unit_count,
      existing_record.record_status::TEXT, existing_record.submitted_by_account_id,
      existing_record.submitted_at, existing_record.message,
      existing_record.supplement_note, existing_record.face_request_id::TEXT,
      existing_record.idempotency_key::TEXT, FALSE;
    RETURN;
  END IF;

  profile_object_ref := public.lock_active_verification_subjects(
    p_store_id, p_teacher_id, p_customer_id, p_product_id, p_submitted_by_account_id
  );

  SELECT photo_draft.* INTO draft
    FROM public.verification_photo_drafts AS photo_draft
   WHERE photo_draft.evidence_token = p_face_evidence_token
     AND photo_draft.store_id = p_store_id
     AND photo_draft.customer_id = p_customer_id
     AND photo_draft.submitted_by_account_id = p_submitted_by_account_id
     AND photo_draft.face_request_id = p_face_request_id
     AND photo_draft.consumed_at IS NULL
     AND photo_draft.expires_at > CLOCK_TIMESTAMP()
   FOR UPDATE;
  IF draft.evidence_token IS NULL THEN
    RAISE EXCEPTION 'face photo evidence is missing, expired, consumed, or belongs to another request'
      USING ERRCODE = '42501';
  END IF;

  IF normalized_type = 'EXPERIENCE' THEN
    SELECT quota_row.* INTO quota
      FROM public.teacher_product_experience_quotas AS quota_row
     WHERE quota_row.teacher_id = p_teacher_id
       AND quota_row.product_id = p_product_id
       AND quota_row.quota_status = 'ACTIVE'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'teacher has no active configured experience quota for this product'
        USING ERRCODE = '23514';
    END IF;
    quota := public.reset_teacher_experience_quota(quota.id, effective_month, NULL);
    IF quota.quota_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'teacher has no active configured experience quota for this product'
        USING ERRCODE = '23514';
    END IF;
    IF quota.available_count < p_unit_count THEN
      RAISE EXCEPTION 'insufficient teacher experience quota for this product'
        USING ERRCODE = '23514';
    END IF;
    quota_before := quota.available_count;
    UPDATE public.teacher_product_experience_quotas AS quota_row
       SET available_count = quota_row.available_count - p_unit_count,
           used_count = quota_row.used_count + p_unit_count,
           updated_at = CLOCK_TIMESTAMP()
     WHERE quota_row.id = quota.id
       AND quota_row.quota_status = 'ACTIVE'
     RETURNING quota_row.* INTO quota;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'teacher experience quota was archived while creating verification'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.verification_records
    (verification_type, store_id, teacher_id, customer_id, product_id,
     unit_count, record_status, submitted_by_account_id, message,
     supplement_note, face_request_id, idempotency_key)
  VALUES
    (normalized_type, p_store_id, p_teacher_id, p_customer_id, p_product_id,
     p_unit_count, normalized_status, p_submitted_by_account_id,
     COALESCE(p_message, ''), COALESCE(p_supplement_note, ''),
     p_face_request_id, p_idempotency_key)
  RETURNING * INTO created_record;

  IF normalized_type = 'EXPERIENCE' THEN
    INSERT INTO public.teacher_experience_quota_usages
      (verification_id, quota_id, teacher_id, product_id, quota_month,
       unit_count, available_before_count, available_after_count)
    VALUES
      (created_record.id, quota.id, p_teacher_id, p_product_id,
       quota.quota_month, p_unit_count, quota_before, quota.available_count)
    RETURNING * INTO usage;
  END IF;

  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref,
     thumbnail_object_ref, original_bytes, thumbnail_bytes,
     image_width, image_height, sha256, uploaded_by_account_id,
     source_evidence_token)
  VALUES
    (created_record.id, 0, 'PROFILE', profile_object_ref,
     profile_object_ref, NULL, NULL, NULL, NULL, NULL,
     p_submitted_by_account_id, NULL),
    (created_record.id, 1, 'FACE', draft.original_object_ref,
     draft.thumbnail_object_ref, draft.original_bytes, draft.thumbnail_bytes,
     draft.image_width, draft.image_height, draft.sha256,
     p_submitted_by_account_id, draft.evidence_token);

  INSERT INTO public.verification_photo_events
    (verification_id, photo_slot, event_type, actor_account_id)
  VALUES
    (created_record.id, 0, 'PROFILE_BOUND', p_submitted_by_account_id),
    (created_record.id, 1, 'FACE_BOUND', p_submitted_by_account_id);

  UPDATE public.verification_photo_drafts AS photo_draft
     SET consumed_by_verification_id = created_record.id,
         consumed_at = NOW()
   WHERE photo_draft.evidence_token = draft.evidence_token;

  IF created_record.verification_type IN ('NORMAL', 'EXPERIENCE')
     AND created_record.record_status = 'APPROVED' THEN
    INSERT INTO public.device_signal_outbox
      (verification_id, store_id, customer_id, product_id, teacher_id)
    VALUES
      (created_record.id, created_record.store_id, created_record.customer_id,
       created_record.product_id, created_record.teacher_id);
  END IF;

  RETURN QUERY SELECT created_record.id, created_record.verification_code::TEXT,
    created_record.verification_type::TEXT, created_record.store_id,
    created_record.teacher_id, created_record.customer_id,
    created_record.product_id, created_record.unit_count,
    created_record.record_status::TEXT, created_record.submitted_by_account_id,
    created_record.submitted_at, created_record.message,
    created_record.supplement_note, created_record.face_request_id::TEXT,
    created_record.idempotency_key::TEXT, TRUE;
END;
$$;

-- The old EXPERIENCE wrapper also fails closed instead of silently supplying
-- a fixed value of one.
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
BEGIN
  RAISE EXCEPTION 'experience verification unit count is required by migration 064'
    USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.create_experience_verification_with_customer_face_photo(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT,
  p_product_id BIGINT, p_unit_count INTEGER,
  p_submitted_by_account_id BIGINT, p_message TEXT,
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
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE existing_id BIGINT;
BEGIN
  IF p_unit_count IS NULL OR p_unit_count < 1 OR p_unit_count > 999 THEN
    RAISE EXCEPTION 'experience verification unit count must be between 1 and 999'
      USING ERRCODE = '22023';
  END IF;
  IF BTRIM(COALESCE(p_idempotency_key, '')) = ''
     OR BTRIM(COALESCE(p_face_request_id, '')) = ''
     OR BTRIM(COALESCE(p_face_evidence_token, '')) = '' THEN
    RAISE EXCEPTION 'experience verification idempotency and customer face evidence are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));
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
    p_product_id, p_unit_count, 'APPROVED'::VARCHAR,
    p_submitted_by_account_id, COALESCE(p_message, '')::TEXT, ''::TEXT,
    p_face_request_id, p_face_evidence_token, p_idempotency_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_experience_verification_with_customer_face_photo(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_experience_verification_with_customer_face_photo(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR
) TO service_role;

REVOKE ALL ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) TO service_role;

REVOKE ALL ON FUNCTION public.create_experience_verification_with_customer_face_photo(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT,
  VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_experience_verification_with_customer_face_photo(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT,
  VARCHAR, VARCHAR, VARCHAR
) TO service_role;

COMMENT ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) IS
  'Migration 064: atomic NORMAL/EXPERIENCE writer with operator-selected unit count, idempotency count matching, balance/quota debit, customer face evidence and device outbox.';
COMMENT ON FUNCTION public.create_experience_verification_with_customer_face_photo(
  BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, TEXT,
  VARCHAR, VARCHAR, VARCHAR
) IS
  'Migration 064: teacher-only EXPERIENCE wrapper requiring an explicit operator-selected unit count and customer face evidence.';

COMMIT;

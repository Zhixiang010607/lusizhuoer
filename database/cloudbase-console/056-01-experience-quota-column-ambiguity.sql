-- CloudBase console migration 056. Execute this entire file once.
-- It is intentionally self-contained and safe to run again.
BEGIN;

DO $$
BEGIN
  IF TO_REGPROCEDURE(
       'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
     ) IS NULL
     OR TO_REGCLASS('public.teacher_product_experience_quotas') IS NULL
     OR TO_REGCLASS('public.teacher_experience_quota_usages') IS NULL THEN
    RAISE EXCEPTION 'migration 056 prerequisites are missing; execute migrations through 055 first';
  END IF;
END;
$$;

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
  IF normalized_status <> (CASE WHEN normalized_type = 'SUPPLEMENT' THEN 'PENDING' ELSE 'APPROVED' END) THEN
    RAISE EXCEPTION 'verification status does not match verification type' USING ERRCODE = '22023';
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
    IF existing_record.verification_type = 'EXPERIENCE' AND NOT EXISTS (
      SELECT 1
        FROM public.teacher_experience_quota_usages AS quota_usage
       WHERE quota_usage.verification_id = existing_record.id
    ) THEN
      RAISE EXCEPTION 'experience verification is missing its teacher quota usage audit row' USING ERRCODE = '23514';
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
    RAISE EXCEPTION 'face photo evidence is missing, expired, consumed, or belongs to another request' USING ERRCODE = '42501';
  END IF;

  IF normalized_type = 'EXPERIENCE' THEN
    SELECT quota_row.* INTO quota
      FROM public.teacher_product_experience_quotas AS quota_row
     WHERE quota_row.teacher_id = p_teacher_id
       AND quota_row.product_id = p_product_id
       AND quota_row.quota_status = 'ACTIVE'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'teacher has no active configured experience quota for this product' USING ERRCODE = '23514';
    END IF;
    quota := public.reset_teacher_experience_quota(quota.id, effective_month, NULL);
    IF quota.quota_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'teacher has no active configured experience quota for this product' USING ERRCODE = '23514';
    END IF;
    IF quota.available_count < 1 THEN
      RAISE EXCEPTION 'insufficient teacher experience quota for this product' USING ERRCODE = '23514';
    END IF;
    quota_before := quota.available_count;
    UPDATE public.teacher_product_experience_quotas AS quota_row
       SET available_count = quota_row.available_count - 1,
           used_count = quota_row.used_count + 1,
           updated_at = CLOCK_TIMESTAMP()
     WHERE quota_row.id = quota.id
       AND quota_row.quota_status = 'ACTIVE'
     RETURNING quota_row.* INTO quota;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'teacher experience quota was archived while creating verification' USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.verification_records
    (verification_type, store_id, teacher_id, customer_id, product_id,
     unit_count, record_status, submitted_by_account_id, message,
     supplement_note, face_request_id, idempotency_key)
  VALUES
    (normalized_type, p_store_id, p_teacher_id, p_customer_id, p_product_id,
     1, normalized_status, p_submitted_by_account_id, COALESCE(p_message, ''),
     COALESCE(p_supplement_note, ''), p_face_request_id, p_idempotency_key)
  RETURNING * INTO created_record;

  IF normalized_type = 'EXPERIENCE' THEN
    INSERT INTO public.teacher_experience_quota_usages
      (verification_id, quota_id, teacher_id, product_id, quota_month,
       unit_count, available_before_count, available_after_count)
    VALUES
      (created_record.id, quota.id, p_teacher_id, p_product_id,
       quota.quota_month, 1, quota_before, quota.available_count)
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

REVOKE ALL ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC;

COMMENT ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) IS
  'Atomic verification writer with explicitly qualified teacher quota columns; EXPERIENCE consumes one active teacher quota and binds customer photos.';

COMMIT;

SELECT 'function' AS kind,
       'public.create_verification_with_face_photo(varchar,bigint,bigint,bigint,bigint,varchar,bigint,text,text,varchar,varchar,varchar)' AS object_name,
       CASE WHEN TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
       ) IS NOT NULL THEN 'READY' ELSE 'MISSING' END AS status;

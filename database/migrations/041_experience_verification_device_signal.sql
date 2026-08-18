-- Experience verification replaces new supplemental-verification entry.
-- NORMAL and EXPERIENCE complete immediately and atomically enqueue exactly
-- one project-access signal. Historical SUPPLEMENT rows remain reviewable.

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
  profile_object_ref TEXT;
  normalized_type TEXT := UPPER(BTRIM(COALESCE(p_verification_type, '')));
  normalized_status TEXT := UPPER(BTRIM(COALESCE(p_record_status, '')));
BEGIN
  IF normalized_type NOT IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE') THEN
    RAISE EXCEPTION 'unsupported verification type' USING ERRCODE = '22023';
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

  SELECT v.*
    INTO existing_record
    FROM public.verification_records AS v
   WHERE v.idempotency_key = p_idempotency_key
   LIMIT 1;

  IF existing_record.id IS NOT NULL THEN
    IF existing_record.verification_type <> normalized_type
       OR existing_record.store_id <> p_store_id
       OR existing_record.teacher_id <> p_teacher_id
       OR existing_record.customer_id <> p_customer_id
       OR existing_record.product_id <> p_product_id
       OR existing_record.submitted_by_account_id <> p_submitted_by_account_id
       OR existing_record.message <> COALESCE(p_message, '')
       OR existing_record.supplement_note <> COALESCE(p_supplement_note, '')
       OR existing_record.face_request_id <> p_face_request_id
       OR NOT EXISTS (
         SELECT 1 FROM public.verification_photos AS photo
          WHERE photo.verification_id = existing_record.id
            AND photo.photo_slot = 0 AND photo.photo_kind = 'PROFILE'
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.verification_photos AS photo
          WHERE photo.verification_id = existing_record.id
            AND photo.photo_slot = 1 AND photo.photo_kind = 'FACE'
            AND photo.source_evidence_token = p_face_evidence_token
       ) THEN
      RAISE EXCEPTION 'idempotency key belongs to a different verification request'
        USING ERRCODE = '23505';
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

    RETURN QUERY SELECT
      existing_record.id, existing_record.verification_code::TEXT,
      existing_record.verification_type::TEXT, existing_record.store_id,
      existing_record.teacher_id, existing_record.customer_id,
      existing_record.product_id, existing_record.unit_count,
      existing_record.record_status::TEXT, existing_record.submitted_by_account_id,
      existing_record.submitted_at, existing_record.message,
      existing_record.supplement_note, existing_record.face_request_id::TEXT,
      existing_record.idempotency_key::TEXT, FALSE;
    RETURN;
  END IF;

  SELECT d.*
    INTO draft
    FROM public.verification_photo_drafts AS d
   WHERE d.evidence_token = p_face_evidence_token
     AND d.store_id = p_store_id
     AND d.customer_id = p_customer_id
     AND d.submitted_by_account_id = p_submitted_by_account_id
     AND d.face_request_id = p_face_request_id
     AND d.consumed_at IS NULL
     AND d.expires_at > CLOCK_TIMESTAMP()
   FOR UPDATE;

  IF draft.evidence_token IS NULL THEN
    RAISE EXCEPTION 'face photo evidence is missing, expired, consumed, or belongs to another request'
      USING ERRCODE = '42501';
  END IF;

  SELECT c.profile_photo_file_id
    INTO profile_object_ref
    FROM public.customers AS c
   WHERE c.id = p_customer_id
     AND c.created_store_id = p_store_id
     AND c.customer_status = 'ACTIVE'
   FOR SHARE;

  IF BTRIM(COALESCE(profile_object_ref, '')) = '' THEN
    RAISE EXCEPTION 'customer retained profile photo is required'
      USING ERRCODE = '22023';
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

  UPDATE public.verification_photo_drafts
     SET consumed_by_verification_id = created_record.id,
         consumed_at = NOW()
   WHERE evidence_token = draft.evidence_token;

  IF created_record.verification_type IN ('NORMAL', 'EXPERIENCE')
     AND created_record.record_status = 'APPROVED' THEN
    INSERT INTO public.device_signal_outbox
      (verification_id, store_id, customer_id, product_id, teacher_id)
    VALUES
      (created_record.id, created_record.store_id, created_record.customer_id,
       created_record.product_id, created_record.teacher_id);
  END IF;

  RETURN QUERY SELECT
    created_record.id, created_record.verification_code::TEXT,
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

COMMIT;

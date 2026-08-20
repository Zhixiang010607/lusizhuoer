-- Migration 049: make the face subject of every new EXPERIENCE verification
-- the selected teacher while the business record remains linked to its customer.
-- It also repairs the 048 quota functions whose unqualified output-column names
-- can raise SQLSTATE 42702 in PL/pgSQL.
BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.teacher_product_experience_quotas') IS NULL
     OR TO_REGCLASS('public.verification_photo_drafts') IS NULL
     OR TO_REGCLASS('public.verification_photos') IS NULL
     OR TO_REGPROCEDURE('public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)') IS NULL THEN
    RAISE EXCEPTION 'migration 049 requires migrations through 048';
  END IF;
END;
$$;

ALTER TABLE public.teachers
  ADD COLUMN IF NOT EXISTS profile_photo_file_id VARCHAR(768);

ALTER TABLE public.verification_photo_drafts
  ADD COLUMN IF NOT EXISTS face_subject_type VARCHAR(16) NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS face_subject_teacher_id BIGINT;
ALTER TABLE public.verification_records
  ADD COLUMN IF NOT EXISTS face_subject_type VARCHAR(16) NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS face_subject_teacher_id BIGINT;
ALTER TABLE public.verification_photos
  ADD COLUMN IF NOT EXISTS face_subject_type VARCHAR(16) NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN IF NOT EXISTS face_subject_teacher_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'verification_photo_drafts_face_subject_teacher_fk'
                    AND conrelid = 'public.verification_photo_drafts'::regclass) THEN
    ALTER TABLE public.verification_photo_drafts ADD CONSTRAINT verification_photo_drafts_face_subject_teacher_fk
      FOREIGN KEY (face_subject_teacher_id) REFERENCES public.teachers(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'verification_records_face_subject_teacher_fk'
                    AND conrelid = 'public.verification_records'::regclass) THEN
    ALTER TABLE public.verification_records ADD CONSTRAINT verification_records_face_subject_teacher_fk
      FOREIGN KEY (face_subject_teacher_id) REFERENCES public.teachers(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'verification_photos_face_subject_teacher_fk'
                    AND conrelid = 'public.verification_photos'::regclass) THEN
    ALTER TABLE public.verification_photos ADD CONSTRAINT verification_photos_face_subject_teacher_fk
      FOREIGN KEY (face_subject_teacher_id) REFERENCES public.teachers(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.verification_photo_drafts
  DROP CONSTRAINT IF EXISTS verification_photo_drafts_face_subject_check;
ALTER TABLE public.verification_photo_drafts
  ADD CONSTRAINT verification_photo_drafts_face_subject_check CHECK (
    (face_subject_type = 'CUSTOMER' AND face_subject_teacher_id IS NULL)
    OR (face_subject_type = 'TEACHER' AND face_subject_teacher_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_face_subject_check;
ALTER TABLE public.verification_records
  ADD CONSTRAINT verification_records_face_subject_check CHECK (
    (face_subject_type = 'CUSTOMER' AND face_subject_teacher_id IS NULL)
    OR (face_subject_type = 'TEACHER' AND face_subject_teacher_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE public.verification_photos
  DROP CONSTRAINT IF EXISTS verification_photos_face_subject_check;
ALTER TABLE public.verification_photos
  ADD CONSTRAINT verification_photos_face_subject_check CHECK (
    (face_subject_type = 'CUSTOMER' AND face_subject_teacher_id IS NULL)
    OR (face_subject_type = 'TEACHER' AND face_subject_teacher_id IS NOT NULL)
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_verification_photo_drafts_teacher_subject
  ON public.verification_photo_drafts (face_subject_teacher_id, created_at DESC)
  WHERE face_subject_type = 'TEACHER' AND consumed_at IS NULL;

CREATE OR REPLACE FUNCTION public.enforce_verification_face_subject()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verification_type = 'EXPERIENCE' THEN
    IF NEW.face_subject_type <> 'TEACHER'
       OR NEW.face_subject_teacher_id IS DISTINCT FROM NEW.teacher_id THEN
      RAISE EXCEPTION 'EXPERIENCE verification requires its teacher as the face subject'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.face_subject_type <> 'CUSTOMER' OR NEW.face_subject_teacher_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-EXPERIENCE verification requires its customer as the face subject'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_verification_face_subject ON public.verification_records;
CREATE TRIGGER trg_enforce_verification_face_subject
BEFORE INSERT OR UPDATE OF verification_type, teacher_id, face_subject_type, face_subject_teacher_id
ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_verification_face_subject();

CREATE OR REPLACE FUNCTION public.inherit_verification_photo_face_subject()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT record.face_subject_type, record.face_subject_teacher_id
    INTO NEW.face_subject_type, NEW.face_subject_teacher_id
    FROM public.verification_records AS record
   WHERE record.id = NEW.verification_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification record does not exist' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inherit_verification_photo_face_subject ON public.verification_photos;
CREATE TRIGGER trg_inherit_verification_photo_face_subject
BEFORE INSERT OR UPDATE OF verification_id ON public.verification_photos
FOR EACH ROW EXECUTE FUNCTION public.inherit_verification_photo_face_subject();

CREATE OR REPLACE FUNCTION public.assert_experience_verification_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verification_type = 'EXPERIENCE' AND (
    NOT EXISTS (
      SELECT 1 FROM public.teacher_experience_quota_usages AS usage
       WHERE usage.verification_id = NEW.id AND usage.teacher_id = NEW.teacher_id
         AND usage.product_id = NEW.product_id AND usage.unit_count = NEW.unit_count
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.verification_photos AS photo
       WHERE photo.verification_id = NEW.id AND photo.photo_slot = 0
         AND photo.photo_kind = 'PROFILE' AND photo.face_subject_type = 'TEACHER'
         AND photo.face_subject_teacher_id = NEW.teacher_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.verification_photos AS photo
       WHERE photo.verification_id = NEW.id AND photo.photo_slot = 1
         AND photo.photo_kind = 'FACE' AND photo.face_subject_type = 'TEACHER'
         AND photo.face_subject_teacher_id = NEW.teacher_id
    )
  ) THEN
    RAISE EXCEPTION 'EXPERIENCE verification requires teacher quota usage and two teacher face photos'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_experience_verification_complete ON public.verification_records;
CREATE CONSTRAINT TRIGGER trg_assert_experience_verification_complete
AFTER INSERT ON public.verification_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_experience_verification_complete();

CREATE OR REPLACE FUNCTION public.upsert_teacher_product_experience_quota(
  p_teacher_id BIGINT, p_product_id BIGINT, p_monthly_allowance INTEGER,
  p_actor_account_id BIGINT
)
RETURNS TABLE(
  id BIGINT, teacher_id BIGINT, product_id BIGINT, monthly_allowance INTEGER,
  quota_month DATE, available_count INTEGER, used_count INTEGER,
  manual_recharge_count INTEGER, monthly_reset_at TIMESTAMPTZ, created_now BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  quota_row public.teacher_product_experience_quotas%ROWTYPE;
  effective_month DATE := public.teacher_experience_quota_month();
  inserted_now BOOLEAN := FALSE;
  previous_available INTEGER := 0;
BEGIN
  IF p_monthly_allowance IS NULL OR p_monthly_allowance < 0 OR p_monthly_allowance > 1000000 THEN
    RAISE EXCEPTION 'monthly allowance must be an integer from 0 to 1000000' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM public.assert_active_teacher_experience_subjects(p_teacher_id, p_product_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));
  INSERT INTO public.teacher_product_experience_quotas
    (teacher_id, product_id, monthly_allowance, quota_month, available_count,
     used_count, manual_recharge_count, quota_status, created_by_account_id, updated_by_account_id)
  VALUES (p_teacher_id, p_product_id, p_monthly_allowance, effective_month,
          p_monthly_allowance, 0, 0, 'ACTIVE', p_actor_account_id, p_actor_account_id)
  ON CONFLICT ON CONSTRAINT uq_teacher_product_experience_quota DO NOTHING
  RETURNING * INTO quota_row;
  IF FOUND THEN
    inserted_now := TRUE;
  ELSE
    SELECT quota.* INTO quota_row
      FROM public.teacher_product_experience_quotas AS quota
     WHERE quota.teacher_id = p_teacher_id AND quota.product_id = p_product_id
     FOR UPDATE;
    previous_available := quota_row.available_count;
    UPDATE public.teacher_product_experience_quotas AS quota
       SET quota_status = 'ACTIVE', archived_at = NULL, archived_by_account_id = NULL,
           monthly_allowance = p_monthly_allowance, quota_month = effective_month,
           available_count = p_monthly_allowance, used_count = 0, manual_recharge_count = 0,
           monthly_reset_at = CLOCK_TIMESTAMP(), updated_by_account_id = p_actor_account_id,
           updated_at = CLOCK_TIMESTAMP()
     WHERE quota.id = quota_row.id RETURNING quota.* INTO quota_row;
  END IF;
  INSERT INTO public.teacher_experience_quota_configuration_events
    (quota_id, teacher_id, product_id, event_type, monthly_allowance, quota_month,
     available_before_count, available_after_count, occurred_by_account_id)
  VALUES (quota_row.id, quota_row.teacher_id, quota_row.product_id, 'CONFIGURED',
          quota_row.monthly_allowance, quota_row.quota_month, previous_available,
          quota_row.available_count, p_actor_account_id);
  RETURN QUERY SELECT quota_row.id, quota_row.teacher_id, quota_row.product_id,
    quota_row.monthly_allowance, quota_row.quota_month, quota_row.available_count,
    quota_row.used_count, quota_row.manual_recharge_count, quota_row.monthly_reset_at, inserted_now;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_teacher_product_experience_quota(
  p_teacher_id BIGINT, p_product_id BIGINT, p_actor_account_id BIGINT
)
RETURNS TABLE(
  quota_id BIGINT, teacher_id BIGINT, product_id BIGINT,
  available_count INTEGER, removed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  quota_row public.teacher_product_experience_quotas%ROWTYPE;
  removed_at_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  PERFORM public.assert_teacher_experience_quota_actor(p_actor_account_id);
  PERFORM pg_advisory_xact_lock(hashtext('teacher-experience-quota:' || p_teacher_id::TEXT || ':' || p_product_id::TEXT));
  SELECT quota.* INTO quota_row FROM public.teacher_product_experience_quotas AS quota
   WHERE quota.teacher_id = p_teacher_id AND quota.product_id = p_product_id
     AND quota.quota_status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no active experience quota for this product' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.teacher_product_experience_quotas AS quota
     SET quota_status = 'ARCHIVED', archived_at = removed_at_value,
         archived_by_account_id = p_actor_account_id, updated_by_account_id = p_actor_account_id,
         updated_at = removed_at_value
   WHERE quota.id = quota_row.id RETURNING quota.* INTO quota_row;
  INSERT INTO public.teacher_experience_quota_configuration_events
    (quota_id, teacher_id, product_id, event_type, monthly_allowance, quota_month,
     available_before_count, available_after_count, occurred_by_account_id, occurred_at)
  VALUES (quota_row.id, quota_row.teacher_id, quota_row.product_id, 'REMOVED',
          quota_row.monthly_allowance, quota_row.quota_month, quota_row.available_count,
          quota_row.available_count, p_actor_account_id, removed_at_value);
  RETURN QUERY SELECT quota_row.id, quota_row.teacher_id, quota_row.product_id,
    quota_row.available_count, removed_at_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.lock_active_teacher_experience_subjects(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT,
  p_product_id BIGINT, p_submitted_by_account_id BIGINT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE profile_object_ref TEXT;
BEGIN
  PERFORM 1 FROM public.stores WHERE id = p_store_id AND store_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store is missing or archived' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.customers
   WHERE id = p_customer_id AND created_store_id = p_store_id AND customer_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer is missing, archived, or belongs to another store' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.products WHERE id = p_product_id AND product_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product is missing or archived' USING ERRCODE = '23514'; END IF;
  SELECT teacher.profile_photo_file_id INTO profile_object_ref
    FROM public.teachers AS teacher
    JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
   WHERE teacher.id = p_teacher_id AND teacher.teacher_status = 'ACTIVE'
     AND account.role_code = 'teacher' AND account.account_status = 'ACTIVE'
     AND teacher.face_enrollment_status = 'ENROLLED'
     AND BTRIM(COALESCE(teacher.face_person_id, '')) <> ''
   FOR SHARE OF teacher, account;
  IF NOT FOUND OR BTRIM(COALESCE(profile_object_ref, '')) = '' THEN
    RAISE EXCEPTION 'TEACHER_FACE_REQUIRED_FOR_EXPERIENCE: teacher retained face profile is required'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.staff_accounts
   WHERE id = p_submitted_by_account_id AND account_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'submitting account is missing or archived' USING ERRCODE = '23514'; END IF;
  RETURN profile_object_ref;
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_teacher_experience_quota(
  p_verification_id BIGINT, p_teacher_id BIGINT, p_product_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  quota_row public.teacher_product_experience_quotas%ROWTYPE;
  quota_before INTEGER;
BEGIN
  SELECT quota.* INTO quota_row FROM public.teacher_product_experience_quotas AS quota
   WHERE quota.teacher_id = p_teacher_id AND quota.product_id = p_product_id
     AND quota.quota_status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher has no active configured experience quota for this product' USING ERRCODE = '23514';
  END IF;
  quota_row := public.reset_teacher_experience_quota(
    quota_row.id, public.teacher_experience_quota_month(), NULL
  );
  IF quota_row.available_count < 1 THEN
    RAISE EXCEPTION 'insufficient teacher experience quota for this product' USING ERRCODE = '23514';
  END IF;
  quota_before := quota_row.available_count;
  UPDATE public.teacher_product_experience_quotas AS quota
     SET available_count = quota.available_count - 1, used_count = quota.used_count + 1,
         updated_at = CLOCK_TIMESTAMP()
   WHERE quota.id = quota_row.id RETURNING quota.* INTO quota_row;
  INSERT INTO public.teacher_experience_quota_usages
    (verification_id, quota_id, teacher_id, product_id, quota_month, unit_count,
     available_before_count, available_after_count)
  VALUES (p_verification_id, quota_row.id, p_teacher_id, p_product_id,
          quota_row.quota_month, 1, quota_before, quota_row.available_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_teacher_experience_face_photos(
  p_verification_id BIGINT, p_store_id BIGINT, p_teacher_id BIGINT,
  p_customer_id BIGINT, p_submitted_by_account_id BIGINT,
  p_face_request_id VARCHAR, p_face_evidence_token VARCHAR, p_profile_object_ref TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE draft_row public.verification_photo_drafts%ROWTYPE;
BEGIN
  SELECT draft.* INTO draft_row FROM public.verification_photo_drafts AS draft
   WHERE draft.evidence_token = p_face_evidence_token AND draft.store_id = p_store_id
     AND draft.customer_id = p_customer_id AND draft.submitted_by_account_id = p_submitted_by_account_id
     AND draft.face_request_id = p_face_request_id AND draft.face_subject_type = 'TEACHER'
     AND draft.face_subject_teacher_id = p_teacher_id AND draft.consumed_at IS NULL
     AND draft.expires_at > CLOCK_TIMESTAMP() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'teacher face photo evidence is missing, expired, consumed, or belongs to another request'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref, thumbnail_object_ref,
     original_bytes, thumbnail_bytes, image_width, image_height, sha256,
     uploaded_by_account_id, source_evidence_token, face_subject_type, face_subject_teacher_id)
  VALUES
    (p_verification_id, 0, 'PROFILE', p_profile_object_ref, p_profile_object_ref,
     NULL, NULL, NULL, NULL, NULL, p_submitted_by_account_id, NULL, 'TEACHER', p_teacher_id),
    (p_verification_id, 1, 'FACE', draft_row.original_object_ref, draft_row.thumbnail_object_ref,
     draft_row.original_bytes, draft_row.thumbnail_bytes, draft_row.image_width, draft_row.image_height,
     draft_row.sha256, p_submitted_by_account_id, draft_row.evidence_token, 'TEACHER', p_teacher_id);
  INSERT INTO public.verification_photo_events
    (verification_id, photo_slot, event_type, actor_account_id)
  VALUES (p_verification_id, 0, 'PROFILE_BOUND', p_submitted_by_account_id),
         (p_verification_id, 1, 'FACE_BOUND', p_submitted_by_account_id);
  UPDATE public.verification_photo_drafts
     SET consumed_by_verification_id = p_verification_id, consumed_at = NOW()
   WHERE evidence_token = draft_row.evidence_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.find_teacher_experience_verification_replay(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR, p_idempotency_key VARCHAR
)
RETURNS public.verification_records
LANGUAGE plpgsql
AS $$
DECLARE existing_record public.verification_records%ROWTYPE;
BEGIN
  SELECT record.* INTO existing_record FROM public.verification_records AS record
   WHERE record.idempotency_key = p_idempotency_key LIMIT 1;
  IF existing_record.id IS NULL THEN RETURN NULL; END IF;
  PERFORM public.assert_matching_verification_idempotency(
    existing_record.id, 'EXPERIENCE', p_store_id, p_teacher_id, p_customer_id,
    p_product_id, p_submitted_by_account_id, p_message, '', p_face_request_id,
    p_face_evidence_token
  );
  IF existing_record.face_subject_type <> 'TEACHER'
     OR existing_record.face_subject_teacher_id IS DISTINCT FROM p_teacher_id
     OR NOT EXISTS (SELECT 1 FROM public.teacher_experience_quota_usages AS usage
                     WHERE usage.verification_id = existing_record.id) THEN
    RAISE EXCEPTION 'experience verification face or quota audit is invalid' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.device_signal_outbox
    (verification_id, store_id, customer_id, product_id, teacher_id)
  VALUES (existing_record.id, existing_record.store_id, existing_record.customer_id,
          existing_record.product_id, existing_record.teacher_id)
  ON CONFLICT (verification_id) DO NOTHING;
  RETURN existing_record;
END;
$$;

CREATE OR REPLACE FUNCTION public.insert_teacher_experience_verification(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR, p_idempotency_key VARCHAR
)
RETURNS public.verification_records
LANGUAGE plpgsql
AS $$
DECLARE
  created_record public.verification_records%ROWTYPE;
  profile_object_ref TEXT;
BEGIN
  profile_object_ref := public.lock_active_teacher_experience_subjects(
    p_store_id, p_teacher_id, p_customer_id, p_product_id, p_submitted_by_account_id
  );
  INSERT INTO public.verification_records
    (verification_type, store_id, teacher_id, customer_id, product_id, unit_count,
     record_status, submitted_by_account_id, message, supplement_note,
     face_request_id, idempotency_key, face_subject_type, face_subject_teacher_id)
  VALUES ('EXPERIENCE', p_store_id, p_teacher_id, p_customer_id, p_product_id, 1,
          'APPROVED', p_submitted_by_account_id, COALESCE(p_message, ''), '',
          p_face_request_id, p_idempotency_key, 'TEACHER', p_teacher_id)
  RETURNING * INTO created_record;
  PERFORM public.consume_teacher_experience_quota(
    created_record.id, p_teacher_id, p_product_id
  );
  PERFORM public.bind_teacher_experience_face_photos(
    created_record.id, p_store_id, p_teacher_id, p_customer_id,
    p_submitted_by_account_id, p_face_request_id, p_face_evidence_token,
    profile_object_ref
  );
  INSERT INTO public.device_signal_outbox
    (verification_id, store_id, customer_id, product_id, teacher_id)
  VALUES (created_record.id, created_record.store_id, created_record.customer_id,
          created_record.product_id, created_record.teacher_id);
  RETURN created_record;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_experience_verification_with_teacher_face_photo(
  p_store_id BIGINT, p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_face_request_id VARCHAR,
  p_face_evidence_token VARCHAR, p_idempotency_key VARCHAR
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
DECLARE
  existing_record public.verification_records%ROWTYPE;
  created_record public.verification_records%ROWTYPE;
BEGIN
  IF BTRIM(COALESCE(p_idempotency_key, '')) = ''
     OR BTRIM(COALESCE(p_face_request_id, '')) = ''
     OR BTRIM(COALESCE(p_face_evidence_token, '')) = '' THEN
    RAISE EXCEPTION 'experience verification idempotency and face evidence are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_idempotency_key));
  existing_record := public.find_teacher_experience_verification_replay(
    p_store_id, p_teacher_id, p_customer_id, p_product_id, p_submitted_by_account_id,
    p_message, p_face_request_id, p_face_evidence_token, p_idempotency_key
  );
  IF existing_record.id IS NOT NULL THEN
    RETURN QUERY SELECT existing_record.id, existing_record.verification_code::TEXT,
      existing_record.verification_type::TEXT, existing_record.store_id,
      existing_record.teacher_id, existing_record.customer_id, existing_record.product_id,
      existing_record.unit_count, existing_record.record_status::TEXT,
      existing_record.submitted_by_account_id, existing_record.submitted_at,
      existing_record.message, existing_record.supplement_note,
      existing_record.face_request_id::TEXT, existing_record.idempotency_key::TEXT, FALSE;
    RETURN;
  END IF;
  created_record := public.insert_teacher_experience_verification(
    p_store_id, p_teacher_id, p_customer_id, p_product_id, p_submitted_by_account_id,
    p_message, p_face_request_id, p_face_evidence_token, p_idempotency_key
  );
  RETURN QUERY SELECT created_record.id, created_record.verification_code::TEXT,
    created_record.verification_type::TEXT, created_record.store_id,
    created_record.teacher_id, created_record.customer_id, created_record.product_id,
    created_record.unit_count, created_record.record_status::TEXT,
    created_record.submitted_by_account_id, created_record.submitted_at,
    created_record.message, created_record.supplement_note,
    created_record.face_request_id::TEXT, created_record.idempotency_key::TEXT, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_verification_face_subject() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inherit_verification_photo_face_subject() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_experience_verification_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_teacher_product_experience_quota(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_active_teacher_experience_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_teacher_experience_quota(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_teacher_experience_face_photos(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_teacher_experience_verification_replay(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.insert_teacher_experience_verification(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_experience_verification_with_teacher_face_photo(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC;

COMMENT ON COLUMN public.teachers.profile_photo_file_id IS
  'Private immutable retained-photo reference for the teacher current face enrollment; old referenced objects remain for historical verification snapshots.';
COMMENT ON COLUMN public.verification_records.face_subject_type IS
  'CUSTOMER for historical/normal verification evidence; TEACHER for every new EXPERIENCE verification after migration 049.';
COMMENT ON FUNCTION public.create_experience_verification_with_teacher_face_photo(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, VARCHAR, VARCHAR, VARCHAR) IS
  'Atomically creates a customer-linked EXPERIENCE verification, snapshots the teacher retained photo, binds the teacher live photo, and consumes one teacher quota unit.';

COMMIT;

-- CloudBase migration 046, part 6 / 8. Run this file by itself.
BEGIN;
-- Final order-state authority.  Migration 044 accidentally made EXPERIENCE
-- pending even though migration 041 and the face-photo function create it as
-- immediately approved.  Keep NORMAL and EXPERIENCE both effective directly.
CREATE OR REPLACE FUNCTION public.guard_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'recharge_records' THEN
      IF NEW.recharge_type NOT IN ('NEW', 'REFUND') THEN
        RAISE EXCEPTION 'new recharge orders must be NEW or REFUND' USING ERRCODE = '23514';
      END IF;
      IF NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a recharge or refund application must start as PENDING' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'verification_records' THEN
      IF NEW.verification_type IN ('NORMAL', 'EXPERIENCE') AND NEW.record_status <> 'APPROVED' THEN
        RAISE EXCEPTION 'a NORMAL or EXPERIENCE verification must be effective immediately' USING ERRCODE = '23514';
      END IF;
      IF NEW.verification_type = 'SUPPLEMENT' AND NEW.record_status <> 'PENDING' THEN
        RAISE EXCEPTION 'a historical SUPPLEMENT verification must start as PENDING' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.record_status IS NOT DISTINCT FROM OLD.record_status THEN RETURN NEW; END IF;
  IF OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED', 'REJECTED') THEN RETURN NEW; END IF;
  IF OLD.record_status = 'APPROVED' AND NEW.record_status = 'VOIDED' AND NEW.void_request_status = 'APPROVED' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid order status transition: % -> %', OLD.record_status, NEW.record_status USING ERRCODE = '23514';
END;
$$;

-- Backend predicates are deliberately repeated at the database boundary. A
-- stale page or direct server-side call cannot select an archived store,
-- teacher, product or customer for a new recharge/refund/verification.
CREATE OR REPLACE FUNCTION public.assert_active_order_master_data()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stores
     WHERE id = NEW.store_id AND store_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing store cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers
     WHERE id = NEW.customer_id
       AND created_store_id = NEW.store_id
       AND customer_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived, missing, or foreign-store customer cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = NEW.product_id AND product_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived or missing product cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NEW.teacher_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.teachers AS teacher
      JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
     WHERE teacher.id = NEW.teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND teacher.face_enrollment_status = 'ENROLLED'
       AND BTRIM(COALESCE(teacher.face_person_id, '')) <> ''
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived, unbound-face, or missing teacher cannot receive a new order' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_accounts
     WHERE id = NEW.submitted_by_account_id
       AND account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'archived submitting account cannot create a new order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recharge_active_master_data ON public.recharge_records;
CREATE TRIGGER trg_recharge_active_master_data
BEFORE INSERT ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.assert_active_order_master_data();

DROP TRIGGER IF EXISTS trg_verification_active_master_data ON public.verification_records;
CREATE TRIGGER trg_verification_active_master_data
BEFORE INSERT ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.assert_active_order_master_data();

-- Keep the verification function small enough for the CloudBase SQL editor
-- while retaining all master-data locks inside the same outer transaction.
CREATE OR REPLACE FUNCTION public.lock_active_verification_subjects(
  p_store_id BIGINT,
  p_teacher_id BIGINT,
  p_customer_id BIGINT,
  p_product_id BIGINT,
  p_submitted_by_account_id BIGINT
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
  PERFORM 1 FROM public.teachers teacher
   WHERE teacher.id = p_teacher_id AND teacher.teacher_status = 'ACTIVE'
     AND teacher.face_enrollment_status = 'ENROLLED'
     AND BTRIM(COALESCE(teacher.face_person_id, '')) <> ''
     AND EXISTS (SELECT 1 FROM public.staff_accounts account
                  WHERE account.id = teacher.staff_account_id
                    AND account.role_code = 'teacher' AND account.account_status = 'ACTIVE') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'teacher is missing, archived, or has not completed face enrollment' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM public.staff_accounts
   WHERE id = p_submitted_by_account_id AND account_status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'submitting account is missing or archived' USING ERRCODE = '23514'; END IF;
  SELECT profile_photo_file_id INTO profile_object_ref FROM public.customers WHERE id = p_customer_id FOR SHARE;
  IF BTRIM(COALESCE(profile_object_ref, '')) = '' THEN
    RAISE EXCEPTION 'customer retained profile photo is required' USING ERRCODE = '22023';
  END IF;
  RETURN profile_object_ref;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_matching_verification_idempotency(
  p_verification_id BIGINT, p_verification_type VARCHAR, p_store_id BIGINT,
  p_teacher_id BIGINT, p_customer_id BIGINT, p_product_id BIGINT,
  p_submitted_by_account_id BIGINT, p_message TEXT, p_supplement_note TEXT,
  p_face_request_id VARCHAR, p_face_evidence_token VARCHAR
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.verification_records v
     WHERE v.id = p_verification_id AND v.verification_type = p_verification_type
       AND v.store_id = p_store_id AND v.teacher_id = p_teacher_id
       AND v.customer_id = p_customer_id AND v.product_id = p_product_id
       AND v.submitted_by_account_id = p_submitted_by_account_id
       AND v.message = COALESCE(p_message, '')
       AND v.supplement_note = COALESCE(p_supplement_note, '')
       AND v.face_request_id = p_face_request_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.verification_photos photo
     WHERE photo.verification_id = p_verification_id AND photo.photo_slot = 0 AND photo.photo_kind = 'PROFILE'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.verification_photos photo
     WHERE photo.verification_id = p_verification_id AND photo.photo_slot = 1
       AND photo.photo_kind = 'FACE' AND photo.source_evidence_token = p_face_evidence_token
  ) THEN
    RAISE EXCEPTION 'idempotency key belongs to a different verification request' USING ERRCODE = '23505';
  END IF;
END;
$$;

COMMIT;

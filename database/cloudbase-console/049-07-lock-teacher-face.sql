-- CloudBase migration 049, part 7 / 13. Run this file by itself.
BEGIN;
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

COMMIT;

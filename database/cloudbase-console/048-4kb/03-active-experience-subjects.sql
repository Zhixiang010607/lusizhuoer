-- 048 fallback, 03/15. Active status, not teacher face, authorizes quotas.
BEGIN;
CREATE OR REPLACE FUNCTION public.assert_active_teacher_experience_subjects(
  p_teacher_id BIGINT,
  p_product_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.teachers AS teacher
      JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
     WHERE teacher.id = p_teacher_id
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'teacher is missing or archived' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products
     WHERE id = p_product_id AND product_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'product is missing or archived' USING ERRCODE = '23514';
  END IF;
END;
$$;
COMMIT;

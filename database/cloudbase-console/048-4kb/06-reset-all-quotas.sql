-- 048 fallback, 06/15. Run only after file 05 committed.
BEGIN;
CREATE OR REPLACE FUNCTION public.reset_teacher_experience_quotas(
  p_effective_month DATE DEFAULT public.teacher_experience_quota_month(),
  p_reset_by_account_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  quota_row RECORD;
  reset_count INTEGER := 0;
BEGIN
  IF p_effective_month <> DATE_TRUNC('month', p_effective_month)::DATE THEN
    RAISE EXCEPTION 'effective quota month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  FOR quota_row IN
    SELECT quota.id
      FROM public.teacher_product_experience_quotas quota
      JOIN public.teachers teacher ON teacher.id = quota.teacher_id
      JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
      JOIN public.products product ON product.id = quota.product_id
     WHERE quota.quota_month < p_effective_month
       AND quota.quota_status = 'ACTIVE'
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
       AND product.product_status = 'ACTIVE'
     ORDER BY quota.id
     FOR UPDATE OF quota SKIP LOCKED
  LOOP
    PERFORM public.reset_teacher_experience_quota(
      quota_row.id, p_effective_month, p_reset_by_account_id
    );
    reset_count := reset_count + 1;
  END LOOP;
  RETURN reset_count;
END;
$$;
COMMIT;

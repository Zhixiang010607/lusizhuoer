-- 048 fallback, 04/15. Run only after file 03 committed.
BEGIN;
CREATE OR REPLACE FUNCTION public.teacher_experience_quota_is_resettable(
  p_quota_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.teacher_product_experience_quotas quota
      JOIN public.teachers teacher ON teacher.id = quota.teacher_id
      JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
      JOIN public.products product ON product.id = quota.product_id
     WHERE quota.id = p_quota_id
       AND quota.quota_status = 'ACTIVE'
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
       AND product.product_status = 'ACTIVE'
  );
$$;
COMMIT;

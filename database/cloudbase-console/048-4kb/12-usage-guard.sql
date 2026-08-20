-- 048 fallback, 13/15. Reject a stale direct usage after the entitlement is removed.
BEGIN;
CREATE OR REPLACE FUNCTION public.assert_active_teacher_experience_quota_usage()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.teacher_product_experience_quotas quota
      JOIN public.teachers teacher ON teacher.id = quota.teacher_id
      JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
      JOIN public.products product ON product.id = quota.product_id
     WHERE quota.id = NEW.quota_id
       AND quota.teacher_id = NEW.teacher_id
       AND quota.product_id = NEW.product_id
       AND quota.quota_status = 'ACTIVE'
       AND teacher.teacher_status = 'ACTIVE'
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
       AND product.product_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'teacher has no active configured experience quota for this product'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_assert_active_teacher_experience_quota_usage
  ON public.teacher_experience_quota_usages;
CREATE TRIGGER trg_assert_active_teacher_experience_quota_usage
BEFORE INSERT ON public.teacher_experience_quota_usages
FOR EACH ROW EXECUTE FUNCTION public.assert_active_teacher_experience_quota_usage();
COMMIT;

-- 048 fallback, 14/15. Finalize function privileges and migration documentation.
BEGIN;
REVOKE ALL ON FUNCTION public.sync_teacher_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_teacher_account_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_teacher_experience_subjects(BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_experience_quota_is_resettable(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_teacher_experience_quota(BIGINT, DATE, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_teacher_experience_quotas(DATE, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_teacher_product_experience_quota(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_teacher_experience_quota_recharge(INTEGER, TEXT, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recharge_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, TEXT, VARCHAR, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_order_master_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_active_verification_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_teacher_experience_quota_usage() FROM PUBLIC;
COMMENT ON TABLE public.teacher_experience_quota_configuration_events IS
  'Immutable configuration/removal history. Removing a live teacher product entitlement archives the quota instead of deleting its audit lineage.';
COMMENT ON FUNCTION public.upsert_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, BIGINT) IS
  'Migration 048: every configuration immediately replaces the current available count with the selected monthly allowance.';
COMMENT ON FUNCTION public.reset_teacher_experience_quotas(DATE, BIGINT) IS
  'Migration 048: monthly reset affects only ACTIVE teacher accounts, ACTIVE teacher profiles, ACTIVE quota configurations, and ACTIVE products.';
COMMIT;

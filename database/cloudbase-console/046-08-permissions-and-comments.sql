-- CloudBase migration 046, part 8 / 8. Run this file by itself.
BEGIN;
REVOKE ALL ON FUNCTION public.teacher_experience_quota_month(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_teacher_experience_quota_actor(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_teacher_experience_subjects(BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_teacher_experience_quota(BIGINT, DATE, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_teacher_experience_quotas(DATE, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recharge_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, TEXT, VARCHAR, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_active_order_master_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_active_verification_subjects(BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_matching_verification_idempotency(
  BIGINT, VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, VARCHAR, VARCHAR
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_verification_with_face_photo(
  VARCHAR, BIGINT, BIGINT, BIGINT, BIGINT, VARCHAR, BIGINT,
  TEXT, TEXT, VARCHAR, VARCHAR, VARCHAR
) FROM PUBLIC;

COMMENT ON TABLE public.teacher_product_experience_quotas IS
  'One configured monthly base allowance for each teacher and product. This is separate from customer purchased-unit balances.';
COMMENT ON TABLE public.teacher_experience_quota_recharges IS
  'Immutable headquarters top-up ledger for a teacher product experience quota.';
COMMENT ON TABLE public.teacher_experience_quota_usages IS
  'Immutable link proving that each new EXPERIENCE verification atomically consumed one teacher quota unit.';
COMMENT ON FUNCTION public.reset_teacher_experience_quotas(DATE, BIGINT) IS
  'Safe monthly reset entry point. Invoke on the first day of each Asia/Shanghai month; reads and consumes also lazily reset.';

COMMIT;

-- CloudBase migration 050, part 7 / 7. Run this file by itself.
BEGIN;
REVOKE ALL ON FUNCTION public.sync_teacher_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_teacher_account_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_teacher_product_experience_quota(BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recharge_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, TEXT, VARCHAR, BIGINT) FROM PUBLIC;

COMMENT ON FUNCTION public.sync_teacher_profile() IS
  'Migration 050: every teacher staff account owns a same-status teacher master row; existing account status is face-independent.';
COMMENT ON FUNCTION public.delete_teacher_product_experience_quota(BIGINT, BIGINT, BIGINT) IS
  'Migration 050: removes only an active teacher/product entitlement and preserves all immutable history.';
COMMENT ON FUNCTION public.recharge_teacher_product_experience_quota(BIGINT, BIGINT, INTEGER, TEXT, VARCHAR, BIGINT) IS
  'Migration 050: idempotent active-entitlement top-up with output-column-safe qualified references.';

COMMIT;

-- 只读验收：生产数据清理后仅保留两个活跃总部账号和三个活跃项目。
-- 本文件不修改任何数据，可在腾讯云 CloudBase PostgreSQL SQL 编辑器整段执行。

WITH operational_counts AS (
  SELECT 'audit_logs' AS table_name, count(*)::bigint AS row_count FROM public.audit_logs
  UNION ALL SELECT 'credential_events', count(*)::bigint FROM public.credential_events
  UNION ALL SELECT 'customer_messages', count(*)::bigint FROM public.customer_messages
  UNION ALL SELECT 'customer_product_balances', count(*)::bigint FROM public.customer_product_balances
  UNION ALL SELECT 'customers', count(*)::bigint FROM public.customers
  UNION ALL SELECT 'device_signal_outbox', count(*)::bigint FROM public.device_signal_outbox
  UNION ALL SELECT 'lsg_stress_run_batches', count(*)::bigint FROM public.lsg_stress_run_batches
  UNION ALL SELECT 'lsg_stress_run_products', count(*)::bigint FROM public.lsg_stress_run_products
  UNION ALL SELECT 'lsg_stress_runs', count(*)::bigint FROM public.lsg_stress_runs
  UNION ALL SELECT 'operation_store_scopes', count(*)::bigint FROM public.operation_store_scopes
  UNION ALL SELECT 'recharge_product_gifts', count(*)::bigint FROM public.recharge_product_gifts
  UNION ALL SELECT 'recharge_records', count(*)::bigint FROM public.recharge_records
  UNION ALL SELECT 'record_status_history', count(*)::bigint FROM public.record_status_history
  UNION ALL SELECT 'retail_product_purchase_records', count(*)::bigint FROM public.retail_product_purchase_records
  UNION ALL SELECT 'retail_product_status_history', count(*)::bigint FROM public.retail_product_status_history
  UNION ALL SELECT 'retail_products', count(*)::bigint FROM public.retail_products
  UNION ALL SELECT 'staff_daily_reports', count(*)::bigint FROM public.staff_daily_reports
  UNION ALL SELECT 'store_contacts', count(*)::bigint FROM public.store_contacts
  UNION ALL SELECT 'stores', count(*)::bigint FROM public.stores
  UNION ALL SELECT 'teacher_attendance_face_profiles', count(*)::bigint FROM public.teacher_attendance_face_profiles
  UNION ALL SELECT 'teacher_attendance_face_replacements', count(*)::bigint FROM public.teacher_attendance_face_replacements
  UNION ALL SELECT 'teacher_attendance_records', count(*)::bigint FROM public.teacher_attendance_records
  UNION ALL SELECT 'teacher_experience_quota_configuration_events', count(*)::bigint FROM public.teacher_experience_quota_configuration_events
  UNION ALL SELECT 'teacher_experience_quota_recharges', count(*)::bigint FROM public.teacher_experience_quota_recharges
  UNION ALL SELECT 'teacher_experience_quota_resets', count(*)::bigint FROM public.teacher_experience_quota_resets
  UNION ALL SELECT 'teacher_experience_quota_usages', count(*)::bigint FROM public.teacher_experience_quota_usages
  UNION ALL SELECT 'teacher_product_experience_quotas', count(*)::bigint FROM public.teacher_product_experience_quotas
  UNION ALL SELECT 'teachers', count(*)::bigint FROM public.teachers
  UNION ALL SELECT 'training_materials', count(*)::bigint FROM public.training_materials
  UNION ALL SELECT 'verification_ble_authorizations', count(*)::bigint FROM public.verification_ble_authorizations
  UNION ALL SELECT 'verification_ble_qualifications', count(*)::bigint FROM public.verification_ble_qualifications
  UNION ALL SELECT 'verification_customer_ratings', count(*)::bigint FROM public.verification_customer_ratings
  UNION ALL SELECT 'verification_photo_drafts', count(*)::bigint FROM public.verification_photo_drafts
  UNION ALL SELECT 'verification_photo_events', count(*)::bigint FROM public.verification_photo_events
  UNION ALL SELECT 'verification_photo_upload_requests', count(*)::bigint FROM public.verification_photo_upload_requests
  UNION ALL SELECT 'verification_photos', count(*)::bigint FROM public.verification_photos
  UNION ALL SELECT 'verification_records', count(*)::bigint FROM public.verification_records
), checks AS (
  SELECT
    '仅保留两个活跃总部账号' AS check_name,
    CASE WHEN count(*) = 2
           AND count(*) FILTER (WHERE role_code = 'hq' AND account_status = 'ACTIVE') = 2
         THEN 'READY' ELSE 'BLOCKED' END AS status,
    count(*)::text AS detail
  FROM public.staff_accounts

  UNION ALL

  SELECT
    '仅保留三个活跃项目',
    CASE WHEN count(*) = 3
           AND count(*) FILTER (WHERE product_status = 'ACTIVE') = 3
         THEN 'READY' ELSE 'BLOCKED' END,
    count(*)::text
  FROM public.products

  UNION ALL

  SELECT
    '其余业务表全部清空',
    CASE WHEN coalesce(sum(row_count), 0) = 0 THEN 'READY' ELSE 'BLOCKED' END,
    coalesce(sum(row_count), 0)::text
  FROM operational_counts
)
SELECT check_name, status, detail
FROM checks
ORDER BY check_name;

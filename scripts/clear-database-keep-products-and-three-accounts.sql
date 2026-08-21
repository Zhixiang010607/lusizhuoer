-- Production cleanup: keep exactly the three product definitions and these identities:
--   HQ 李志翔 (staff_accounts.id = 1)
--   HQ 乐玉米 (staff_accounts.id = 4)
--   Teacher 苗苗 (staff_accounts.id = 420, teachers.id = 26)
--
-- Everything else in the current public application schema is test/business data.
-- This script is intentionally fail-closed: any schema drift or whitelist mismatch
-- aborts the whole transaction. Cloud storage objects and CloudBase Auth users are
-- outside PostgreSQL and are not modified here.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

DO $$
DECLARE
  expected_tables text[] := ARRAY[
    'audit_logs',
    'credential_events',
    'customer_messages',
    'customer_product_balances',
    'customers',
    'device_signal_outbox',
    'lsg_stress_run_batches',
    'lsg_stress_run_products',
    'lsg_stress_runs',
    'operation_store_scopes',
    'products',
    'recharge_records',
    'record_status_history',
    'staff_accounts',
    'store_contacts',
    'stores',
    'teacher_experience_quota_configuration_events',
    'teacher_experience_quota_recharges',
    'teacher_experience_quota_resets',
    'teacher_experience_quota_usages',
    'teacher_product_experience_quotas',
    'teachers',
    'verification_photo_drafts',
    'verification_photo_events',
    'verification_photo_upload_requests',
    'verification_photos',
    'verification_records'
  ]::text[];
  actual_tables text[];
BEGIN
  SELECT array_agg(t.table_name::text ORDER BY t.table_name)
    INTO actual_tables
    FROM information_schema.tables t
   WHERE t.table_schema = 'public'
     AND t.table_type = 'BASE TABLE';

  IF actual_tables IS DISTINCT FROM expected_tables THEN
    RAISE EXCEPTION 'public table set changed; cleanup refused. expected %, actual %',
      expected_tables, actual_tables
      USING ERRCODE = '55000';
  END IF;
END;
$$;

LOCK TABLE
  public.audit_logs,
  public.credential_events,
  public.customer_messages,
  public.customer_product_balances,
  public.customers,
  public.device_signal_outbox,
  public.lsg_stress_run_batches,
  public.lsg_stress_run_products,
  public.lsg_stress_runs,
  public.operation_store_scopes,
  public.products,
  public.recharge_records,
  public.record_status_history,
  public.staff_accounts,
  public.store_contacts,
  public.stores,
  public.teacher_experience_quota_configuration_events,
  public.teacher_experience_quota_recharges,
  public.teacher_experience_quota_resets,
  public.teacher_experience_quota_usages,
  public.teacher_product_experience_quotas,
  public.teachers,
  public.verification_photo_drafts,
  public.verification_photo_events,
  public.verification_photo_upload_requests,
  public.verification_photos,
  public.verification_records
IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_accounts
     WHERE id = 1 AND staff_name = '李志翔' AND phone = '13970422329'
       AND role_code = 'hq' AND auth_uid = '2085744699220090881'
  ) THEN
    RAISE EXCEPTION 'HQ whitelist mismatch for 李志翔 (staff_accounts.id=1)'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff_accounts
     WHERE id = 4 AND staff_name = '乐玉米' AND phone = '18179422788'
       AND role_code = 'hq' AND auth_uid = '2088898656064479234'
  ) THEN
    RAISE EXCEPTION 'HQ whitelist mismatch for 乐玉米 (staff_accounts.id=4)'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff_accounts
     WHERE id = 420 AND staff_name = '苗苗' AND phone = '18087025447'
       AND role_code = 'teacher' AND auth_uid = '2090678883953905666'
  ) THEN
    RAISE EXCEPTION 'teacher account whitelist mismatch for 苗苗 (staff_accounts.id=420)'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.teachers
     WHERE id = 26 AND staff_account_id = 420
       AND teacher_name = '苗苗' AND teacher_code = 'TCHF420'
  ) THEN
    RAISE EXCEPTION 'teacher profile whitelist mismatch for 苗苗 (teachers.id=26)'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT COUNT(*) FROM public.products) <> 3 OR NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = 1 AND product_code = 'PRD001' AND product_name = '海洋之蕴'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = 2 AND product_code = 'PRD002' AND product_name = '魔法柔肤'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = 3 AND product_code = 'PRD003' AND product_name = '露思康辰'
  ) THEN
    RAISE EXCEPTION 'three-product whitelist mismatch; cleanup refused'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.products
     WHERE receipt_template_updated_by IS NOT NULL
       AND receipt_template_updated_by NOT IN (1, 4, 420)
  ) THEN
    RAISE EXCEPTION 'a retained product references an account scheduled for deletion'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE TEMP TABLE _keep_accounts_snapshot ON COMMIT DROP AS
SELECT id, to_jsonb(a) AS row_data
  FROM public.staff_accounts a
 WHERE id IN (1, 4, 420);

CREATE TEMP TABLE _keep_teacher_snapshot ON COMMIT DROP AS
SELECT id, to_jsonb(t) AS row_data
  FROM public.teachers t
 WHERE id = 26;

CREATE TEMP TABLE _keep_products_snapshot ON COMMIT DROP AS
SELECT id, to_jsonb(p) AS row_data
  FROM public.products p
 ORDER BY id;

CREATE TEMP TABLE _removed_counts ON COMMIT DROP AS
SELECT
  (SELECT COUNT(*) FROM public.staff_accounts WHERE id NOT IN (1, 4, 420)) AS removed_accounts,
  (SELECT COUNT(*) FROM public.teachers WHERE id <> 26) AS removed_teachers,
  (SELECT COUNT(*) FROM public.stores) AS removed_stores,
  (SELECT COUNT(*) FROM public.customers) AS removed_customers,
  (SELECT COUNT(*) FROM public.recharge_records) AS removed_recharges,
  (SELECT COUNT(*) FROM public.verification_records) AS removed_verifications;

TRUNCATE TABLE
  public.audit_logs,
  public.credential_events,
  public.customer_messages,
  public.customer_product_balances,
  public.customers,
  public.device_signal_outbox,
  public.lsg_stress_run_batches,
  public.lsg_stress_run_products,
  public.lsg_stress_runs,
  public.operation_store_scopes,
  public.recharge_records,
  public.record_status_history,
  public.store_contacts,
  public.stores,
  public.teacher_experience_quota_configuration_events,
  public.teacher_experience_quota_recharges,
  public.teacher_experience_quota_resets,
  public.teacher_experience_quota_usages,
  public.teacher_product_experience_quotas,
  public.verification_photo_drafts,
  public.verification_photo_events,
  public.verification_photo_upload_requests,
  public.verification_photos,
  public.verification_records
RESTART IDENTITY;

DELETE FROM public.teachers
 WHERE id <> 26;

DELETE FROM public.staff_accounts
 WHERE id NOT IN (1, 4, 420);

DO $$
DECLARE
  nonempty_tables text[];
BEGIN
  IF (SELECT COUNT(*) FROM public.staff_accounts) <> 3
     OR EXISTS (
       SELECT 1
         FROM _keep_accounts_snapshot s
         JOIN public.staff_accounts a USING (id)
        WHERE to_jsonb(a) IS DISTINCT FROM s.row_data
     )
     OR (SELECT COUNT(*) FROM _keep_accounts_snapshot) <> 3 THEN
    RAISE EXCEPTION 'retained staff account verification failed; rolling back'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT COUNT(*) FROM public.teachers) <> 1
     OR EXISTS (
       SELECT 1
         FROM _keep_teacher_snapshot s
         JOIN public.teachers t USING (id)
        WHERE to_jsonb(t) IS DISTINCT FROM s.row_data
     )
     OR (SELECT COUNT(*) FROM _keep_teacher_snapshot) <> 1 THEN
    RAISE EXCEPTION 'retained teacher verification failed; rolling back'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT COUNT(*) FROM public.products) <> 3
     OR EXISTS (
       SELECT 1
         FROM _keep_products_snapshot s
         FULL JOIN public.products p USING (id)
        WHERE p.id IS NULL OR s.id IS NULL OR to_jsonb(p) IS DISTINCT FROM s.row_data
     ) THEN
    RAISE EXCEPTION 'retained product verification failed; rolling back'
      USING ERRCODE = '55000';
  END IF;

  SELECT array_agg(table_name ORDER BY table_name)
    INTO nonempty_tables
    FROM (
      SELECT 'audit_logs' AS table_name WHERE EXISTS (SELECT 1 FROM public.audit_logs)
      UNION ALL SELECT 'credential_events' WHERE EXISTS (SELECT 1 FROM public.credential_events)
      UNION ALL SELECT 'customer_messages' WHERE EXISTS (SELECT 1 FROM public.customer_messages)
      UNION ALL SELECT 'customer_product_balances' WHERE EXISTS (SELECT 1 FROM public.customer_product_balances)
      UNION ALL SELECT 'customers' WHERE EXISTS (SELECT 1 FROM public.customers)
      UNION ALL SELECT 'device_signal_outbox' WHERE EXISTS (SELECT 1 FROM public.device_signal_outbox)
      UNION ALL SELECT 'lsg_stress_run_batches' WHERE EXISTS (SELECT 1 FROM public.lsg_stress_run_batches)
      UNION ALL SELECT 'lsg_stress_run_products' WHERE EXISTS (SELECT 1 FROM public.lsg_stress_run_products)
      UNION ALL SELECT 'lsg_stress_runs' WHERE EXISTS (SELECT 1 FROM public.lsg_stress_runs)
      UNION ALL SELECT 'operation_store_scopes' WHERE EXISTS (SELECT 1 FROM public.operation_store_scopes)
      UNION ALL SELECT 'recharge_records' WHERE EXISTS (SELECT 1 FROM public.recharge_records)
      UNION ALL SELECT 'record_status_history' WHERE EXISTS (SELECT 1 FROM public.record_status_history)
      UNION ALL SELECT 'store_contacts' WHERE EXISTS (SELECT 1 FROM public.store_contacts)
      UNION ALL SELECT 'stores' WHERE EXISTS (SELECT 1 FROM public.stores)
      UNION ALL SELECT 'teacher_experience_quota_configuration_events' WHERE EXISTS (SELECT 1 FROM public.teacher_experience_quota_configuration_events)
      UNION ALL SELECT 'teacher_experience_quota_recharges' WHERE EXISTS (SELECT 1 FROM public.teacher_experience_quota_recharges)
      UNION ALL SELECT 'teacher_experience_quota_resets' WHERE EXISTS (SELECT 1 FROM public.teacher_experience_quota_resets)
      UNION ALL SELECT 'teacher_experience_quota_usages' WHERE EXISTS (SELECT 1 FROM public.teacher_experience_quota_usages)
      UNION ALL SELECT 'teacher_product_experience_quotas' WHERE EXISTS (SELECT 1 FROM public.teacher_product_experience_quotas)
      UNION ALL SELECT 'verification_photo_drafts' WHERE EXISTS (SELECT 1 FROM public.verification_photo_drafts)
      UNION ALL SELECT 'verification_photo_events' WHERE EXISTS (SELECT 1 FROM public.verification_photo_events)
      UNION ALL SELECT 'verification_photo_upload_requests' WHERE EXISTS (SELECT 1 FROM public.verification_photo_upload_requests)
      UNION ALL SELECT 'verification_photos' WHERE EXISTS (SELECT 1 FROM public.verification_photos)
      UNION ALL SELECT 'verification_records' WHERE EXISTS (SELECT 1 FROM public.verification_records)
    ) remaining;

  IF nonempty_tables IS NOT NULL THEN
    RAISE EXCEPTION 'operational tables not empty after cleanup: %', nonempty_tables
      USING ERRCODE = '55000';
  END IF;
END;
$$;

SELECT * FROM _removed_counts;

COMMIT;

SELECT
  (SELECT COUNT(*) FROM public.products) AS retained_products,
  (SELECT COUNT(*) FROM public.staff_accounts) AS retained_accounts,
  (SELECT COUNT(*) FROM public.teachers) AS retained_teachers,
  (SELECT string_agg(staff_name, '、' ORDER BY id) FROM public.staff_accounts) AS retained_account_names,
  (SELECT teacher_name FROM public.teachers WHERE id = 26) AS retained_teacher_name;

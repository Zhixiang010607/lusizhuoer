-- Large-scale statistics workload and correctness verification.
--
-- Workload persisted on success:
--   * 100 new stores and 100 new teachers;
--   * 100 new customers per store (10,000 customers);
--   * exactly three EXISTING ACTIVE products selected by the lowest product id;
--   * one approved recharge document per customer/product, unit_count = 50
--     (30,000 recharge documents; 1,500,000 recharged units);
--   * exactly 50 approved verification documents per customer/product
--     (1,350,000 NORMAL plus 150,000 EXPERIENCE documents);
--   * one approved 10-unit refund per product for every tenth customer
--     (3,000 refund documents; 30,000 refunded units).
--
-- No product row is inserted, updated, archived, or deleted. No customer or
-- verification photo row is written. EXPERIENCE never consumes purchased
-- units. A normal customer/product finishes with 5 units; the deliberately
-- over-consuming refund cases verify the zero floor and finish with 0 units.
--
-- IMPORTANT: run only after the reviewed cleanup script succeeds, and during
-- an exclusive test window in the intended CloudBase environment. A fail-closed
-- preflight refuses to run if any business data or non-HQ account remains.
-- This transaction blocks concurrent business writes so every assertion sees
-- one stable data set. Four expensive summary/history triggers are disabled
-- only for the bulk fact inserts, restored immediately, and verified before
-- any summary assertion. The synthetic load intentionally produces no
-- status-history, photo, or device-signal rows.
--
-- CloudBase's PostgreSQL SQL editor does not support psql's backslash-based
-- ON_ERROR_STOP command. BEGIN plus PostgreSQL's aborted-transaction behavior
-- is the equivalent safety boundary here: every explicit assertion uses
-- RAISE EXCEPTION, and any SQL error aborts this transaction. COMMIT can run
-- only after every insert, aggregate check, time-bucket check and product
-- fingerprint check succeeds; an aborted transaction cannot be committed.

BEGIN;

SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '2min';

-- Fail closed before taking any application-table lock or writing any data.
-- The destructive cleanup script must have just completed: operational tables
-- are empty, retained accounts are HQ-only, and at least three products remain.
DO $clean_preflight$
DECLARE
  required_table text;
  business_table text;
  current_count bigint;
  account_count bigint;
  non_hq_count bigint;
  product_count bigint;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'staff_accounts', 'products', 'stores', 'teachers', 'customers',
    'recharge_records', 'verification_records',
    'customer_product_balances', 'record_status_history',
    'device_signal_outbox', 'verification_photos',
    'verification_photo_events'
  ]
  LOOP
    IF TO_REGCLASS(FORMAT('%I.%I', 'public', required_table)) IS NULL THEN
      RAISE EXCEPTION
        'stress preflight failed: required table public.% is missing',
        required_table;
    END IF;
  END LOOP;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE role_code <> 'hq')
    INTO account_count, non_hq_count
  FROM public.staff_accounts;
  IF account_count < 1 OR non_hq_count <> 0 THEN
    RAISE EXCEPTION
      'stress preflight failed: staff_accounts must contain only retained HQ accounts (total %, non-HQ %)',
      account_count, non_hq_count;
  END IF;

  SELECT COUNT(*) INTO product_count FROM public.products;
  IF product_count < 3 THEN
    RAISE EXCEPTION
      'stress preflight failed: at least 3 preserved products are required, found %',
      product_count;
  END IF;

  FOREACH business_table IN ARRAY ARRAY[
    'audit_logs', 'business_events', 'credential_events',
    'customer_messages', 'customer_product_balances', 'customers',
    'device_signal_outbox', 'operation_profiles', 'operation_store_scopes',
    'recharge_records', 'recharge_void_requests', 'record_status_history',
    'staff_store_assignments', 'store_contacts', 'stores', 'teachers',
    'verification_photo_drafts', 'verification_photo_events',
    'verification_photo_upload_requests', 'verification_photos',
    'verification_records', 'verification_review_requests'
  ]
  LOOP
    IF TO_REGCLASS(FORMAT('%I.%I', 'public', business_table)) IS NOT NULL THEN
      EXECUTE FORMAT('SELECT COUNT(*) FROM %I.%I', 'public', business_table)
        INTO current_count;
      IF current_count <> 0 THEN
        RAISE EXCEPTION
          'stress preflight failed: public.% was not cleared (% rows remain)',
          business_table, current_count;
      END IF;
    END IF;
  END LOOP;
END;
$clean_preflight$;

-- Lock every known public application table that exists, in a stable order.
-- SHARE ROW EXCLUSIVE blocks concurrent business writes while reads continue.
DO $lock_application_tables$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'access_roles', 'account_identity_links', 'account_role_assignments',
    'audit_logs', 'business_events', 'credential_events',
    'customer_messages', 'customer_product_balances', 'customers',
    'device_signal_outbox', 'hq_profiles', 'operation_profiles',
    'operation_store_scopes', 'products', 'recharge_records',
    'recharge_void_requests', 'record_status_history', 'role_permissions',
    'staff_accounts', 'staff_store_assignments', 'store_contacts', 'stores',
    'teachers', 'verification_photo_drafts', 'verification_photo_events',
    'verification_photo_upload_requests', 'verification_photos',
    'verification_records', 'verification_review_requests'
  ]
  LOOP
    IF TO_REGCLASS(FORMAT('%I.%I', 'public', table_name)) IS NOT NULL THEN
      EXECUTE FORMAT(
        'LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE',
        'public', table_name
      );
    END IF;
  END LOOP;
END;
$lock_application_tables$;

-- Repeat the emptiness check after locks close the check/write race window.
DO $clean_locked_recheck$
DECLARE
  business_table text;
  current_count bigint;
  account_count bigint;
  non_hq_count bigint;
  product_count bigint;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE role_code <> 'hq')
    INTO account_count, non_hq_count
  FROM public.staff_accounts;
  IF account_count < 1 OR non_hq_count <> 0 THEN
    RAISE EXCEPTION
      'stress locked recheck failed: staff_accounts total %, non-HQ %',
      account_count, non_hq_count;
  END IF;

  SELECT COUNT(*) INTO product_count FROM public.products;
  IF product_count < 3 THEN
    RAISE EXCEPTION
      'stress locked recheck failed: only % products remain', product_count;
  END IF;

  FOREACH business_table IN ARRAY ARRAY[
    'audit_logs', 'business_events', 'credential_events',
    'customer_messages', 'customer_product_balances', 'customers',
    'device_signal_outbox', 'operation_profiles', 'operation_store_scopes',
    'recharge_records', 'recharge_void_requests', 'record_status_history',
    'staff_store_assignments', 'store_contacts', 'stores', 'teachers',
    'verification_photo_drafts', 'verification_photo_events',
    'verification_photo_upload_requests', 'verification_photos',
    'verification_records', 'verification_review_requests'
  ]
  LOOP
    IF TO_REGCLASS(FORMAT('%I.%I', 'public', business_table)) IS NOT NULL THEN
      EXECUTE FORMAT('SELECT COUNT(*) FROM %I.%I', 'public', business_table)
        INTO current_count;
      IF current_count <> 0 THEN
        RAISE EXCEPTION
          'stress locked recheck failed: public.% contains % rows',
          business_table, current_count;
      END IF;
    END IF;
  END LOOP;
END;
$clean_locked_recheck$;

-- ---------------------------------------------------------------------------
-- 0) CLEANUP AREA RESERVED FOR THE CALLER
-- ---------------------------------------------------------------------------
-- The main deployment workflow may add an explicitly reviewed cleanup block
-- here for previous LSG runs. This script deliberately performs no broad
-- DELETE and never deletes from public.products. All assertions below are
-- scoped to the unique run_tag created for this transaction, so old stress
-- runs cannot change the result of the current run.

-- ---------------------------------------------------------------------------
-- 1) Parameters, assertion helpers and immutable product selection
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE stress_params ON COMMIT DROP AS
SELECT
  ('LSG_' || SUBSTRING(MD5(
    clock_timestamp()::text || ':' || pg_backend_pid()::text || ':' || txid_current()::text
  ) FROM 1 FOR 12))::varchar(16) AS run_tag,
  DATE_TRUNC('minute', clock_timestamp()) - INTERVAL '2 minutes' AS run_anchor,
  100::integer AS store_count,
  100::integer AS teacher_count,
  100::integer AS customers_per_store,
  3::integer AS selected_product_count,
  50::integer AS purchased_units_per_product,
  50::integer AS verifications_per_product,
  5::integer AS experience_verifications_per_product,
  10::integer AS refund_units_per_product,
  (
    SELECT account.id
    FROM public.staff_accounts account
    WHERE account.role_code = 'hq'
      AND account.account_status = 'ACTIVE'
    ORDER BY account.id
    LIMIT 1
  )::bigint AS reviewer_account_id;

CREATE OR REPLACE FUNCTION pg_temp.stress_assert_eq(
  p_label text,
  p_actual bigint,
  p_expected bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'stress assertion failed [%]: expected %, actual %',
      p_label, p_expected, p_actual;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.stress_assert_true(
  p_label text,
  p_value boolean
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_value IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'stress assertion failed [%]', p_label;
  END IF;
END;
$$;

CREATE TEMP TABLE stress_product_inventory_before ON COMMIT DROP AS
SELECT
  COUNT(*)::bigint AS row_count,
  MD5(COALESCE(STRING_AGG(TO_JSONB(p)::text, '|' ORDER BY p.id), '')) AS fingerprint
FROM public.products p;

CREATE TEMP TABLE stress_product_map ON COMMIT DROP AS
SELECT
  ROW_NUMBER() OVER (ORDER BY chosen.id)::integer AS product_idx,
  chosen.id AS product_id,
  chosen.product_name
FROM (
  SELECT p.id, p.product_name
  FROM public.products p
  WHERE p.product_status = 'ACTIVE'
  ORDER BY p.id
  LIMIT 3
) AS chosen;

ANALYZE stress_product_map;

SELECT pg_temp.stress_assert_eq(
  'three existing active products are available',
  (SELECT COUNT(*) FROM stress_product_map),
  (SELECT selected_product_count FROM stress_params)
);
SELECT pg_temp.stress_assert_true(
  'an active retained HQ reviewer is available',
  (SELECT reviewer_account_id IS NOT NULL FROM stress_params)
);

-- ---------------------------------------------------------------------------
-- 2) Build exactly 100 store accounts and 100 stores
-- ---------------------------------------------------------------------------
-- Select 200 currently unused synthetic phone numbers while staff_accounts is
-- write-locked. This keeps repeated persisted stress runs collision-free.
CREATE TEMP TABLE stress_unused_phone_candidates ON COMMIT DROP AS
SELECT ('199' || LPAD(g.phone_suffix::text, 8, '0'))::char(11) AS phone
FROM GENERATE_SERIES(1, 99999999) AS g(phone_suffix)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.staff_accounts account
  WHERE account.phone = ('199' || LPAD(g.phone_suffix::text, 8, '0'))::char(11)
)
LIMIT 200;

CREATE TEMP TABLE stress_phone_pool ON COMMIT DROP AS
SELECT
  ROW_NUMBER() OVER (ORDER BY phone)::integer AS phone_idx,
  phone
FROM stress_unused_phone_candidates;

SELECT pg_temp.stress_assert_eq(
  '200 unused staff phone numbers are available',
  (SELECT COUNT(*) FROM stress_phone_pool),
  200
);

CREATE TEMP TABLE stress_store_staff_inputs ON COMMIT DROP AS
SELECT
  p.run_tag,
  g.store_idx,
  FORMAT('%sS%s', p.run_tag, LPAD(g.store_idx::text, 3, '0')) AS staff_code,
  FORMAT('%s_store_auth_%s', p.run_tag, LPAD(g.store_idx::text, 3, '0')) AS auth_uid,
  phone.phone,
  FORMAT('%s Store Staff %s', p.run_tag, LPAD(g.store_idx::text, 3, '0')) AS staff_name
FROM stress_params p
CROSS JOIN LATERAL GENERATE_SERIES(1, p.store_count) AS g(store_idx)
JOIN stress_phone_pool phone ON phone.phone_idx = g.store_idx;

ANALYZE stress_store_staff_inputs;

INSERT INTO public.staff_accounts
  (staff_code, auth_uid, phone, staff_name, role_code, account_status)
SELECT staff_code, auth_uid, phone, staff_name, 'store', 'ACTIVE'
FROM stress_store_staff_inputs;

CREATE TEMP TABLE stress_store_staff_map ON COMMIT DROP AS
SELECT
  i.store_idx,
  i.staff_code,
  sa.id AS staff_account_id
FROM stress_store_staff_inputs i
JOIN public.staff_accounts sa ON sa.staff_code = i.staff_code;

ANALYZE stress_store_staff_map;

INSERT INTO public.stores
  (store_code, store_name, province, city, district, address_detail,
   store_account_id, store_status)
SELECT
  FORMAT('%sS%s', i.run_tag, LPAD(i.store_idx::text, 3, '0')),
  FORMAT('%s Store %s', i.run_tag, LPAD(i.store_idx::text, 3, '0')),
  '测试省',
  '测试市',
  '测试区',
  FORMAT('%s Store Address %s', i.run_tag, LPAD(i.store_idx::text, 3, '0')),
  m.staff_account_id,
  'ACTIVE'
FROM stress_store_staff_inputs i
JOIN stress_store_staff_map m
  ON m.store_idx = i.store_idx
 AND m.staff_code = i.staff_code;

CREATE TEMP TABLE stress_store_map ON COMMIT DROP AS
SELECT
  i.store_idx,
  s.id AS store_id,
  m.staff_account_id
FROM stress_store_staff_inputs i
JOIN stress_store_staff_map m
  ON m.store_idx = i.store_idx
 AND m.staff_code = i.staff_code
JOIN public.stores s
  ON s.store_account_id = m.staff_account_id
 AND s.store_name = FORMAT('%s Store %s', i.run_tag, LPAD(i.store_idx::text, 3, '0'));

ANALYZE stress_store_map;

SELECT pg_temp.stress_assert_eq(
  'store account count',
  (SELECT COUNT(*) FROM stress_store_staff_map),
  (SELECT store_count FROM stress_params)
);
SELECT pg_temp.stress_assert_eq(
  'store count',
  (SELECT COUNT(*) FROM stress_store_map),
  (SELECT store_count FROM stress_params)
);

-- ---------------------------------------------------------------------------
-- 3) Build exactly 100 teachers through the canonical account trigger
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE stress_teacher_inputs ON COMMIT DROP AS
SELECT
  p.run_tag,
  g.teacher_idx,
  FORMAT('%sT%s', p.run_tag, LPAD(g.teacher_idx::text, 3, '0')) AS staff_code,
  FORMAT('%s_teacher_auth_%s', p.run_tag, LPAD(g.teacher_idx::text, 3, '0')) AS auth_uid,
  phone.phone,
  FORMAT('%s Teacher %s', p.run_tag, LPAD(g.teacher_idx::text, 3, '0')) AS staff_name
FROM stress_params p
CROSS JOIN LATERAL GENERATE_SERIES(1, p.teacher_count) AS g(teacher_idx)
JOIN stress_phone_pool phone
  ON phone.phone_idx = p.store_count + g.teacher_idx;

ANALYZE stress_teacher_inputs;

INSERT INTO public.staff_accounts
  (staff_code, auth_uid, phone, staff_name, role_code, account_status)
SELECT staff_code, auth_uid, phone, staff_name, 'teacher', 'ACTIVE'
FROM stress_teacher_inputs;

CREATE TEMP TABLE stress_teacher_map ON COMMIT DROP AS
SELECT
  i.teacher_idx,
  sa.id AS staff_account_id,
  t.id AS teacher_id
FROM stress_teacher_inputs i
JOIN public.staff_accounts sa ON sa.staff_code = i.staff_code
JOIN public.teachers t ON t.staff_account_id = sa.id;

ANALYZE stress_teacher_map;

SELECT pg_temp.stress_assert_eq(
  'teacher account and profile count',
  (SELECT COUNT(*) FROM stress_teacher_map),
  (SELECT teacher_count FROM stress_params)
);

-- ---------------------------------------------------------------------------
-- 4) Build exactly 100 customers per store; keep every photo column NULL
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE stress_customer_inputs ON COMMIT DROP AS
SELECT
  p.run_tag,
  s.store_idx,
  s.store_id,
  s.staff_account_id AS store_staff_account_id,
  g.customer_seq,
  FORMAT(
    '%sC%s%s',
    p.run_tag,
    LPAD(s.store_idx::text, 3, '0'),
    LPAD(g.customer_seq::text, 3, '0')
  ) AS customer_code
FROM stress_params p
JOIN stress_store_map s ON TRUE
CROSS JOIN LATERAL GENERATE_SERIES(1, p.customers_per_store) AS g(customer_seq);

ANALYZE stress_customer_inputs;

SELECT pg_temp.stress_assert_true(
  'generated customer codes fit VARCHAR(32)',
  (SELECT COALESCE(MAX(LENGTH(customer_code)), 0) <= 32 FROM stress_customer_inputs)
);

CREATE TEMP TABLE stress_customer_map ON COMMIT DROP AS
WITH inserted AS (
  INSERT INTO public.customers
    (customer_code, customer_name, birth_date, created_store_id, customer_status, notes)
  SELECT
    i.customer_code,
    FORMAT(
      '%s Customer %s-%s',
      i.run_tag,
      LPAD(i.store_idx::text, 3, '0'),
      LPAD(i.customer_seq::text, 3, '0')
    ),
    (DATE '1980-01-01' + ((i.store_idx * 1000 + i.customer_seq) % 14000))::date,
    i.store_id,
    'ACTIVE',
    FORMAT('large-scale-no-photo %s', i.run_tag)
  FROM stress_customer_inputs i
  RETURNING id, customer_code
)
SELECT
  i.store_idx,
  i.store_id,
  i.store_staff_account_id,
  i.customer_seq,
  i.customer_code,
  inserted.id AS customer_id
FROM stress_customer_inputs i
JOIN inserted ON inserted.customer_code = i.customer_code;

ANALYZE stress_customer_map;

SELECT pg_temp.stress_assert_eq(
  'total customer count',
  (SELECT COUNT(*) FROM stress_customer_map),
  (SELECT store_count * customers_per_store FROM stress_params)
);
SELECT pg_temp.stress_assert_eq(
  'every store has exactly 100 customers',
  (
    SELECT COUNT(*)
    FROM (
      SELECT store_id
      FROM stress_customer_map
      GROUP BY store_id
      HAVING COUNT(*) <> (SELECT customers_per_store FROM stress_params)
    ) AS mismatch
  ),
  0
);

CREATE TEMP TABLE stress_customer_product_map ON COMMIT DROP AS
SELECT
  c.store_idx,
  c.store_id,
  c.store_staff_account_id,
  c.customer_id,
  c.customer_seq,
  p.product_idx,
  p.product_id
FROM stress_customer_map c
CROSS JOIN stress_product_map p;

ANALYZE stress_customer_product_map;

SELECT pg_temp.stress_assert_eq(
  'customer/product combinations',
  (SELECT COUNT(*) FROM stress_customer_product_map),
  (
    SELECT store_count * customers_per_store * selected_product_count
    FROM stress_params
  )
);

-- ---------------------------------------------------------------------------
-- 5) Bulk fact load with only four expensive triggers suspended
-- ---------------------------------------------------------------------------
-- Keep customer/store validation, lifecycle guards, constraints and every
-- other USER trigger enabled. Refuse to start unless all four named triggers
-- exist and were enabled, so the script never changes an intentional pre-run
-- trigger state.
SELECT pg_temp.stress_assert_eq(
  'four bulk triggers exist',
  (
    SELECT COUNT(*)
    FROM pg_catalog.pg_trigger t
    WHERE NOT t.tgisinternal
      AND (
        (
          t.tgrelid = 'public.recharge_records'::regclass
          AND t.tgname IN (
            'trg_recharge_refresh_customer_balance',
            'trg_recharge_status_history'
          )
        )
        OR
        (
          t.tgrelid = 'public.verification_records'::regclass
          AND t.tgname IN (
            'trg_verification_refresh_customer_balance',
            'trg_verification_status_history'
          )
        )
      )
  ),
  4
);
SELECT pg_temp.stress_assert_eq(
  'four bulk triggers start enabled',
  (
    SELECT COUNT(*)
    FROM pg_catalog.pg_trigger t
    WHERE NOT t.tgisinternal
      AND t.tgenabled = 'O'
      AND (
        (
          t.tgrelid = 'public.recharge_records'::regclass
          AND t.tgname IN (
            'trg_recharge_refresh_customer_balance',
            'trg_recharge_status_history'
          )
        )
        OR
        (
          t.tgrelid = 'public.verification_records'::regclass
          AND t.tgname IN (
            'trg_verification_refresh_customer_balance',
            'trg_verification_status_history'
          )
        )
      )
  ),
  4
);

ALTER TABLE public.recharge_records
  DISABLE TRIGGER trg_recharge_refresh_customer_balance;
ALTER TABLE public.recharge_records
  DISABLE TRIGGER trg_recharge_status_history;
ALTER TABLE public.verification_records
  DISABLE TRIGGER trg_verification_refresh_customer_balance;
ALTER TABLE public.verification_records
  DISABLE TRIGGER trg_verification_status_history;

-- One approved recharge document per customer/product, unit_count = 50.
CREATE TEMP TABLE stress_recharge_rows ON COMMIT DROP AS
SELECT
  FORMAT(
    '%sR%s',
    p.run_tag,
    LPAD(ROW_NUMBER() OVER (ORDER BY cp.customer_id, cp.product_id)::text, 5, '0')
  )::varchar(32) AS recharge_code,
  cp.store_id,
  cp.store_staff_account_id,
  cp.customer_id,
  cp.product_id,
  t.teacher_id,
  p.purchased_units_per_product AS unit_count,
  p.run_anchor - INTERVAL '60 days' AS submitted_at
FROM stress_customer_product_map cp
JOIN stress_params p ON TRUE
JOIN stress_teacher_map t
  ON t.teacher_idx = 1 + MOD(
    cp.store_idx * 31 + cp.customer_seq * 7 + cp.product_idx * 13,
    p.teacher_count
  );

ANALYZE stress_recharge_rows;

INSERT INTO public.recharge_records
  (recharge_code, recharge_type, store_id, teacher_id, customer_id, product_id, unit_count,
   record_status, submitted_by_account_id, submitted_at,
   reviewed_by_account_id, reviewed_at, message)
SELECT
  r.recharge_code,
  'NEW',
  r.store_id,
  r.teacher_id,
  r.customer_id,
  r.product_id,
  r.unit_count,
  'APPROVED',
  r.store_staff_account_id,
  r.submitted_at,
  p.reviewer_account_id,
  r.submitted_at + INTERVAL '1 minute',
  FORMAT('large-scale-no-photo %s', p.run_tag)
FROM stress_recharge_rows r
JOIN stress_params p ON TRUE;

-- Every tenth customer receives one deliberately larger-than-remaining
-- refund per product. The approved 10-unit refund reduces purchased units to
-- 40 while 45 NORMAL uses remain, exercising the required GREATEST(..., 0)
-- balance floor. The audit snapshot states 5 units before and 0 after.
CREATE TEMP TABLE stress_refund_rows ON COMMIT DROP AS
SELECT
  FORMAT(
    '%sF%s',
    p.run_tag,
    LPAD(ROW_NUMBER() OVER (ORDER BY cp.customer_id, cp.product_id)::text, 4, '0')
  )::varchar(32) AS recharge_code,
  cp.store_id,
  cp.store_staff_account_id,
  cp.customer_id,
  cp.product_id,
  t.teacher_id,
  p.refund_units_per_product AS unit_count,
  5::integer AS balance_before_count,
  0::integer AS balance_after_count,
  p.run_anchor - INTERVAL '20 days' AS submitted_at
FROM stress_customer_product_map cp
JOIN stress_params p ON TRUE
JOIN stress_teacher_map t
  ON t.teacher_idx = 1 + MOD(
    cp.store_idx * 19 + cp.customer_seq * 23 + cp.product_idx * 29,
    p.teacher_count
  )
WHERE MOD(cp.customer_seq, 10) = 0;

ANALYZE stress_refund_rows;

INSERT INTO public.recharge_records
  (recharge_code, recharge_type, store_id, teacher_id, customer_id, product_id, unit_count,
   balance_before_count, balance_after_count, record_status,
   submitted_by_account_id, submitted_at,
   reviewed_by_account_id, reviewed_at, message)
SELECT
  r.recharge_code,
  'REFUND',
  r.store_id,
  r.teacher_id,
  r.customer_id,
  r.product_id,
  r.unit_count,
  r.balance_before_count,
  r.balance_after_count,
  'APPROVED',
  r.store_staff_account_id,
  r.submitted_at,
  p.reviewer_account_id,
  r.submitted_at + INTERVAL '1 minute',
  FORMAT('large-scale-no-photo %s', p.run_tag)
FROM stress_refund_rows r
JOIN stress_params p ON TRUE;

-- Exactly 50 verifications per customer/product. A customer/product hash
-- rotates the five EXPERIENCE positions within each ten-use block: placement
-- looks random while every group remains exactly 45 NORMAL + 5 EXPERIENCE.
CREATE TEMP TABLE stress_usage_rows ON COMMIT DROP AS
SELECT
  FORMAT(
    '%sV%s',
    p.run_tag,
    LPAD(
      ROW_NUMBER() OVER (ORDER BY cp.customer_id, cp.product_id, g.use_no)::text,
      7,
      '0'
    )
  )::varchar(32) AS verification_code,
  cp.store_idx,
  cp.store_id,
  cp.store_staff_account_id,
  cp.customer_id,
  cp.customer_seq,
  cp.product_idx,
  cp.product_id,
  g.use_no,
  t.teacher_id,
  (
    CASE
      WHEN MOD(
        (g.use_no - 1)::bigint
          + ABS(HASHTEXT(cp.customer_id::text || ':' || cp.product_id::text)::bigint),
        10
      ) = 0 THEN 'EXPERIENCE'
      ELSE 'NORMAL'
    END
  )::varchar(16) AS verification_type,
  p.run_anchor - ((g.use_no - 1) * INTERVAL '1 day') AS submitted_at
FROM stress_customer_product_map cp
JOIN stress_params p ON TRUE
CROSS JOIN LATERAL GENERATE_SERIES(1, p.verifications_per_product) AS g(use_no)
JOIN stress_teacher_map t
  ON t.teacher_idx = 1 + MOD(
    cp.store_idx * 17 + cp.customer_seq * 11 + cp.product_idx * 5 + g.use_no - 1,
    p.teacher_count
  );

ANALYZE stress_usage_rows;

SELECT pg_temp.stress_assert_eq(
  'generated verification rows',
  (SELECT COUNT(*) FROM stress_usage_rows),
  1500000
);
SELECT pg_temp.stress_assert_eq(
  'every customer/product has exactly 50 verification rows',
  (
    SELECT COUNT(*)
    FROM (
      SELECT customer_id, product_id
      FROM stress_usage_rows
      GROUP BY customer_id, product_id
      HAVING COUNT(*) <> 50
         OR COUNT(*) FILTER (WHERE verification_type = 'NORMAL') <> 45
         OR COUNT(*) FILTER (WHERE verification_type = 'EXPERIENCE') <> 5
    ) AS mismatch
  ),
  0
);

INSERT INTO public.verification_records
  (verification_code, verification_type, store_id, teacher_id, customer_id, product_id, unit_count,
   record_status, submitted_by_account_id, reviewed_by_account_id,
   submitted_at, reviewed_at, message)
SELECT
  u.verification_code,
  u.verification_type,
  u.store_id,
  u.teacher_id,
  u.customer_id,
  u.product_id,
  1,
  'APPROVED',
  u.store_staff_account_id,
  p.reviewer_account_id,
  u.submitted_at,
  u.submitted_at + INTERVAL '1 minute',
  FORMAT('large-scale-no-photo %s', p.run_tag)
FROM stress_usage_rows u
JOIN stress_params p ON TRUE;

-- Restore the four suspended triggers before any correctness assertion. If a
-- preceding statement fails, PostgreSQL aborts this transaction and rolls the
-- ALTER TABLE changes back together with all inserted rows.
ALTER TABLE public.recharge_records
  ENABLE TRIGGER trg_recharge_refresh_customer_balance;
ALTER TABLE public.recharge_records
  ENABLE TRIGGER trg_recharge_status_history;
ALTER TABLE public.verification_records
  ENABLE TRIGGER trg_verification_refresh_customer_balance;
ALTER TABLE public.verification_records
  ENABLE TRIGGER trg_verification_status_history;

SELECT pg_temp.stress_assert_eq(
  'four suspended triggers were restored',
  (
    SELECT COUNT(*)
    FROM pg_catalog.pg_trigger t
    WHERE NOT t.tgisinternal
      AND t.tgenabled = 'O'
      AND (
        (
          t.tgrelid = 'public.recharge_records'::regclass
          AND t.tgname IN (
            'trg_recharge_refresh_customer_balance',
            'trg_recharge_status_history'
          )
        )
        OR
        (
          t.tgrelid = 'public.verification_records'::regclass
          AND t.tgname IN (
            'trg_verification_refresh_customer_balance',
            'trg_verification_status_history'
          )
        )
      )
  ),
  4
);

-- Rebuild exactly the state those suspended summary triggers would produce.
-- A refunded combination stores 40 purchased, 45 consuming and a zero-floor
-- balance; every other combination stores 50 / 45 / 5.
SELECT pg_temp.stress_assert_eq(
  'new customers have no balance rows before explicit rebuild',
  (
    SELECT COUNT(*)
    FROM public.customer_product_balances b
    JOIN stress_customer_map c ON c.customer_id = b.customer_id
  ),
  0
);

INSERT INTO public.customer_product_balances
  (customer_id, product_id, total_recharge_count,
   total_verification_count, remaining_count, updated_at)
SELECT
  cp.customer_id,
  cp.product_id,
  CASE WHEN MOD(cp.customer_seq, 10) = 0 THEN 40 ELSE 50 END,
  45,
  CASE WHEN MOD(cp.customer_seq, 10) = 0 THEN 0 ELSE 5 END,
  CLOCK_TIMESTAMP()
FROM stress_customer_product_map cp;

UPDATE public.customers c
SET
  total_recharge_count = CASE
    WHEN MOD(m.customer_seq, 10) = 0 THEN 120
    ELSE 150
  END,
  total_verification_count = 150,
  total_experience_count = 15,
  latest_recharge_at = p.run_anchor - INTERVAL '60 days',
  latest_verification_at = p.run_anchor,
  customer_process_status = 'RECHARGED_WITH_CONSUMPTION',
  updated_at = CLOCK_TIMESTAMP()
FROM stress_customer_map m
JOIN stress_params p ON TRUE
WHERE c.id = m.customer_id;

SELECT pg_temp.stress_assert_eq(
  'new recharge document count',
  (
    SELECT COUNT(*)
    FROM public.recharge_records rr
    JOIN stress_customer_map c ON c.customer_id = rr.customer_id
    WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'NEW'
  ),
  30000
);
SELECT pg_temp.stress_assert_eq(
  'new recharge unit count',
  (
    SELECT COALESCE(SUM(rr.unit_count), 0)
    FROM public.recharge_records rr
    JOIN stress_customer_map c ON c.customer_id = rr.customer_id
    WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'NEW'
  ),
  1500000
);
SELECT pg_temp.stress_assert_eq(
  'refund document count',
  (
    SELECT COUNT(*)
    FROM public.recharge_records rr
    JOIN stress_customer_map c ON c.customer_id = rr.customer_id
    WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'REFUND'
  ),
  3000
);
SELECT pg_temp.stress_assert_eq(
  'refund unit count',
  (
    SELECT COALESCE(SUM(rr.unit_count), 0)
    FROM public.recharge_records rr
    JOIN stress_customer_map c ON c.customer_id = rr.customer_id
    WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'REFUND'
  ),
  30000
);
SELECT pg_temp.stress_assert_eq(
  'refund before/after snapshots are 5/0',
  (
    SELECT COUNT(*)
    FROM public.recharge_records rr
    JOIN stress_customer_map c ON c.customer_id = rr.customer_id
    WHERE rr.recharge_type = 'REFUND'
      AND (
        rr.balance_before_count IS DISTINCT FROM 5
        OR rr.balance_after_count IS DISTINCT FROM 0
      )
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'approved verification document count',
  (
    SELECT COUNT(*)
    FROM public.verification_records vr
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
    WHERE vr.record_status = 'APPROVED'
      AND vr.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')
  ),
  1500000
);
SELECT pg_temp.stress_assert_eq(
  'approved normal verification count',
  (
    SELECT COUNT(*)
    FROM public.verification_records vr
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
    WHERE vr.record_status = 'APPROVED'
      AND vr.verification_type = 'NORMAL'
  ),
  1350000
);
SELECT pg_temp.stress_assert_eq(
  'approved experience verification count',
  (
    SELECT COUNT(*)
    FROM public.verification_records vr
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
    WHERE vr.record_status = 'APPROVED'
      AND vr.verification_type = 'EXPERIENCE'
  ),
  150000
);
SELECT pg_temp.stress_assert_true(
  'approved verification count is at least 500000',
  (
    SELECT COUNT(*) >= 500000
    FROM public.verification_records vr
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
    WHERE vr.record_status = 'APPROVED'
  )
);

-- ---------------------------------------------------------------------------
-- 7) Store/product statistics: aggregate each fact table before joining
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE stress_expected_store_product ON COMMIT DROP AS
SELECT
  s.store_id,
  product.product_id,
  (p.customers_per_store * p.purchased_units_per_product)::bigint AS recharge_units,
  (
    (p.customers_per_store / 10) * p.refund_units_per_product
  )::bigint AS refund_units,
  (
    p.customers_per_store
      * (p.verifications_per_product - p.experience_verifications_per_product)
  )::bigint AS normal_verifications,
  (
    p.customers_per_store * p.experience_verifications_per_product
  )::bigint AS experience_verifications,
  (
    (p.customers_per_store - (p.customers_per_store / 10))
      * (
        p.purchased_units_per_product
          - (p.verifications_per_product - p.experience_verifications_per_product)
      )
  )::bigint AS remaining_units
FROM stress_store_map s
CROSS JOIN stress_product_map product
JOIN stress_params p ON TRUE;

CREATE TEMP TABLE stress_actual_store_product_recharge ON COMMIT DROP AS
SELECT
  rr.store_id,
  rr.product_id,
  COALESCE(SUM(rr.unit_count) FILTER (
    WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'NEW'
  ), 0)::bigint AS recharge_units,
  COALESCE(SUM(rr.unit_count) FILTER (
    WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'REFUND'
  ), 0)::bigint AS refund_units
FROM public.recharge_records rr
JOIN stress_customer_map c ON c.customer_id = rr.customer_id
GROUP BY rr.store_id, rr.product_id;

CREATE TEMP TABLE stress_actual_store_product_verification ON COMMIT DROP AS
SELECT
  vr.store_id,
  vr.product_id,
  COALESCE(SUM(vr.unit_count) FILTER (
    WHERE vr.record_status = 'APPROVED'
      AND vr.verification_type IN ('NORMAL', 'SUPPLEMENT')
  ), 0)::bigint AS normal_verifications,
  COALESCE(SUM(vr.unit_count) FILTER (
    WHERE vr.record_status = 'APPROVED'
      AND vr.verification_type = 'EXPERIENCE'
  ), 0)::bigint AS experience_verifications
FROM public.verification_records vr
JOIN stress_customer_map c ON c.customer_id = vr.customer_id
GROUP BY vr.store_id, vr.product_id;

CREATE TEMP TABLE stress_actual_store_product_balance ON COMMIT DROP AS
SELECT
  c.store_id,
  b.product_id,
  SUM(b.remaining_count)::bigint AS remaining_units
FROM public.customer_product_balances b
JOIN stress_customer_map c ON c.customer_id = b.customer_id
GROUP BY c.store_id, b.product_id;

CREATE TEMP TABLE stress_store_product_mismatch ON COMMIT DROP AS
SELECT
  e.store_id,
  e.product_id,
  e.recharge_units AS expected_recharge_units,
  r.recharge_units AS actual_recharge_units,
  e.refund_units AS expected_refund_units,
  r.refund_units AS actual_refund_units,
  e.normal_verifications AS expected_normal_verifications,
  v.normal_verifications AS actual_normal_verifications,
  e.experience_verifications AS expected_experience_verifications,
  v.experience_verifications AS actual_experience_verifications,
  e.remaining_units AS expected_remaining_units,
  b.remaining_units AS actual_remaining_units
FROM stress_expected_store_product e
LEFT JOIN stress_actual_store_product_recharge r
  ON r.store_id = e.store_id AND r.product_id = e.product_id
LEFT JOIN stress_actual_store_product_verification v
  ON v.store_id = e.store_id AND v.product_id = e.product_id
LEFT JOIN stress_actual_store_product_balance b
  ON b.store_id = e.store_id AND b.product_id = e.product_id
WHERE r.store_id IS NULL
   OR v.store_id IS NULL
   OR b.store_id IS NULL
   OR r.recharge_units IS DISTINCT FROM e.recharge_units
   OR r.refund_units IS DISTINCT FROM e.refund_units
   OR v.normal_verifications IS DISTINCT FROM e.normal_verifications
   OR v.experience_verifications IS DISTINCT FROM e.experience_verifications
   OR b.remaining_units IS DISTINCT FROM e.remaining_units;

SELECT pg_temp.stress_assert_eq(
  'store/product aggregate row count',
  (SELECT COUNT(*) FROM stress_expected_store_product),
  300
);
SELECT pg_temp.stress_assert_eq(
  'store/product recharge, verification, experience, refund and balance aggregates',
  (SELECT COUNT(*) FROM stress_store_product_mismatch),
  0
);

-- ---------------------------------------------------------------------------
-- 8) Teacher statistics: recharge and verification are aggregated separately
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE stress_expected_teacher ON COMMIT DROP AS
WITH recharge AS (
  SELECT teacher_id, SUM(unit_count)::bigint AS recharge_units
  FROM stress_recharge_rows
  GROUP BY teacher_id
), refund AS (
  SELECT teacher_id, SUM(unit_count)::bigint AS refund_units
  FROM stress_refund_rows
  GROUP BY teacher_id
), verification AS (
  SELECT
    teacher_id,
    COUNT(*) FILTER (WHERE verification_type = 'NORMAL')::bigint AS normal_verifications,
    COUNT(*) FILTER (WHERE verification_type = 'EXPERIENCE')::bigint AS experience_verifications
  FROM stress_usage_rows
  GROUP BY teacher_id
)
SELECT
  t.teacher_id,
  COALESCE(r.recharge_units, 0)::bigint AS recharge_units,
  COALESCE(f.refund_units, 0)::bigint AS refund_units,
  COALESCE(v.normal_verifications, 0)::bigint AS normal_verifications,
  COALESCE(v.experience_verifications, 0)::bigint AS experience_verifications
FROM stress_teacher_map t
LEFT JOIN recharge r ON r.teacher_id = t.teacher_id
LEFT JOIN refund f ON f.teacher_id = t.teacher_id
LEFT JOIN verification v ON v.teacher_id = t.teacher_id;

CREATE TEMP TABLE stress_actual_teacher ON COMMIT DROP AS
WITH recharge AS (
  SELECT
    rr.teacher_id,
    COALESCE(SUM(rr.unit_count) FILTER (
      WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'NEW'
    ), 0)::bigint AS recharge_units,
    COALESCE(SUM(rr.unit_count) FILTER (
      WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'REFUND'
    ), 0)::bigint AS refund_units
  FROM public.recharge_records rr
  JOIN stress_customer_map c ON c.customer_id = rr.customer_id
  GROUP BY rr.teacher_id
), verification AS (
  SELECT
    vr.teacher_id,
    SUM(vr.unit_count) FILTER (
      WHERE vr.record_status = 'APPROVED'
        AND vr.verification_type IN ('NORMAL', 'SUPPLEMENT')
    )::bigint AS normal_verifications,
    SUM(vr.unit_count) FILTER (
      WHERE vr.record_status = 'APPROVED'
        AND vr.verification_type = 'EXPERIENCE'
    )::bigint AS experience_verifications
  FROM public.verification_records vr
  JOIN stress_customer_map c ON c.customer_id = vr.customer_id
  GROUP BY vr.teacher_id
)
SELECT
  t.teacher_id,
  COALESCE(r.recharge_units, 0)::bigint AS recharge_units,
  COALESCE(r.refund_units, 0)::bigint AS refund_units,
  COALESCE(v.normal_verifications, 0)::bigint AS normal_verifications,
  COALESCE(v.experience_verifications, 0)::bigint AS experience_verifications
FROM stress_teacher_map t
LEFT JOIN recharge r ON r.teacher_id = t.teacher_id
LEFT JOIN verification v ON v.teacher_id = t.teacher_id;

SELECT pg_temp.stress_assert_eq(
  'teacher aggregate row count',
  (SELECT COUNT(*) FROM stress_actual_teacher),
  100
);
SELECT pg_temp.stress_assert_eq(
  'all teachers receive recharge, refund, normal and experience data',
  (
    SELECT COUNT(*) FROM stress_actual_teacher
    WHERE recharge_units <= 0
       OR refund_units <= 0
       OR normal_verifications <= 0
       OR experience_verifications <= 0
  ),
  0
);
SELECT pg_temp.stress_assert_eq(
  'teacher recharge, refund, normal and experience aggregates',
  (
    SELECT COUNT(*)
    FROM stress_expected_teacher e
    JOIN stress_actual_teacher a ON a.teacher_id = e.teacher_id
    WHERE a.recharge_units IS DISTINCT FROM e.recharge_units
       OR a.refund_units IS DISTINCT FROM e.refund_units
       OR a.normal_verifications IS DISTINCT FROM e.normal_verifications
       OR a.experience_verifications IS DISTINCT FROM e.experience_verifications
  ),
  0
);

-- ---------------------------------------------------------------------------
-- 9) Product statistics across all 100 stores
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE stress_expected_product ON COMMIT DROP AS
SELECT
  product_id,
  SUM(recharge_units)::bigint AS recharge_units,
  SUM(refund_units)::bigint AS refund_units,
  SUM(normal_verifications)::bigint AS normal_verifications,
  SUM(experience_verifications)::bigint AS experience_verifications,
  SUM(remaining_units)::bigint AS remaining_units
FROM stress_expected_store_product
GROUP BY product_id;

CREATE TEMP TABLE stress_actual_product ON COMMIT DROP AS
SELECT
  p.product_id,
  SUM(r.recharge_units)::bigint AS recharge_units,
  SUM(r.refund_units)::bigint AS refund_units,
  SUM(v.normal_verifications)::bigint AS normal_verifications,
  SUM(v.experience_verifications)::bigint AS experience_verifications,
  SUM(b.remaining_units)::bigint AS remaining_units
FROM stress_product_map p
JOIN stress_actual_store_product_recharge r ON r.product_id = p.product_id
JOIN stress_actual_store_product_verification v
  ON v.product_id = p.product_id AND v.store_id = r.store_id
JOIN stress_actual_store_product_balance b
  ON b.product_id = p.product_id AND b.store_id = r.store_id
GROUP BY p.product_id;

SELECT pg_temp.stress_assert_eq(
  'project aggregate row count',
  (SELECT COUNT(*) FROM stress_actual_product),
  3
);
SELECT pg_temp.stress_assert_eq(
  'project aggregates across all stores',
  (
    SELECT COUNT(*)
    FROM stress_expected_product e
    JOIN stress_actual_product a ON a.product_id = e.product_id
    WHERE a.recharge_units IS DISTINCT FROM e.recharge_units
       OR a.refund_units IS DISTINCT FROM e.refund_units
       OR a.normal_verifications IS DISTINCT FROM e.normal_verifications
       OR a.experience_verifications IS DISTINCT FROM e.experience_verifications
       OR a.remaining_units IS DISTINCT FROM e.remaining_units
  ),
  0
);

-- ---------------------------------------------------------------------------
-- 10) Customer totals, per-product balances and process state
-- ---------------------------------------------------------------------------
SELECT pg_temp.stress_assert_eq(
  'three balance rows per customer with exact zero-floor refund results',
  (
    SELECT COUNT(*)
    FROM (
      SELECT
        c.customer_id,
        c.customer_seq,
        COUNT(b.product_id) AS product_rows,
        SUM(b.total_recharge_count) AS recharge_units,
        SUM(b.total_verification_count) AS consuming_verifications,
        SUM(b.remaining_count) AS remaining_units
      FROM stress_customer_map c
      LEFT JOIN public.customer_product_balances b ON b.customer_id = c.customer_id
      GROUP BY c.customer_id, c.customer_seq
      HAVING COUNT(b.product_id) <> 3
         OR SUM(b.total_recharge_count) <> CASE
              WHEN MOD(c.customer_seq, 10) = 0 THEN 120
              ELSE 150
            END
         OR SUM(b.total_verification_count) <> 135
         OR SUM(b.remaining_count) <> CASE
              WHEN MOD(c.customer_seq, 10) = 0 THEN 0
              ELSE 15
            END
    ) AS mismatch
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'exactly 1000 customers exercise refund zero-floor balances',
  (
    SELECT COUNT(*)
    FROM stress_customer_map c
    JOIN public.customers customer ON customer.id = c.customer_id
    WHERE MOD(c.customer_seq, 10) = 0
      AND customer.total_recharge_count = 120
  ),
  1000
);

SELECT pg_temp.stress_assert_eq(
  'customer cached totals, status and latest timestamps',
  (
    SELECT COUNT(*)
    FROM public.customers c
    JOIN stress_customer_map m ON m.customer_id = c.id
    JOIN stress_params p ON TRUE
    WHERE c.customer_status <> 'ACTIVE'
       OR c.customer_process_status <> 'RECHARGED_WITH_CONSUMPTION'
       OR c.total_recharge_count <> CASE
            WHEN MOD(m.customer_seq, 10) = 0 THEN 120
            ELSE 150
          END
       OR c.total_verification_count <> 150
       OR c.total_experience_count <> 15
       OR c.latest_recharge_at IS DISTINCT FROM p.run_anchor - INTERVAL '60 days'
       OR c.latest_verification_at IS DISTINCT FROM p.run_anchor
       OR c.profile_photo_file_id IS NOT NULL
  ),
  0
);

-- ---------------------------------------------------------------------------
-- 11) Time statistics: compare independently aggregated expected/actual days
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE stress_expected_recharge_day ON COMMIT DROP AS
SELECT
  submitted_at::date AS business_date,
  COALESCE(SUM(unit_count) FILTER (WHERE recharge_type = 'NEW'), 0)::bigint AS recharge_units,
  COALESCE(SUM(unit_count) FILTER (WHERE recharge_type = 'REFUND'), 0)::bigint AS refund_units
FROM (
  SELECT submitted_at, unit_count, 'NEW'::varchar(16) AS recharge_type
  FROM stress_recharge_rows
  UNION ALL
  SELECT submitted_at, unit_count, 'REFUND'::varchar(16) AS recharge_type
  FROM stress_refund_rows
) AS expected
GROUP BY submitted_at::date;

CREATE TEMP TABLE stress_actual_recharge_day ON COMMIT DROP AS
SELECT
  rr.submitted_at::date AS business_date,
  COALESCE(SUM(rr.unit_count) FILTER (
    WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'NEW'
  ), 0)::bigint AS recharge_units,
  COALESCE(SUM(rr.unit_count) FILTER (
    WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'REFUND'
  ), 0)::bigint AS refund_units
FROM public.recharge_records rr
JOIN stress_customer_map c ON c.customer_id = rr.customer_id
GROUP BY rr.submitted_at::date;

SELECT pg_temp.stress_assert_eq(
  'two recharge/refund business-day buckets',
  (SELECT COUNT(*) FROM stress_actual_recharge_day),
  2
);
SELECT pg_temp.stress_assert_eq(
  'recharge and refund daily time-bucket statistics',
  (
    SELECT COUNT(*)
    FROM stress_expected_recharge_day e
    FULL OUTER JOIN stress_actual_recharge_day a USING (business_date)
    WHERE e.business_date IS NULL
       OR a.business_date IS NULL
       OR a.recharge_units IS DISTINCT FROM e.recharge_units
       OR a.refund_units IS DISTINCT FROM e.refund_units
  ),
  0
);

CREATE TEMP TABLE stress_expected_verification_day ON COMMIT DROP AS
SELECT
  submitted_at::date AS business_date,
  COUNT(*) FILTER (WHERE verification_type = 'NORMAL')::bigint AS normal_count,
  COUNT(*) FILTER (WHERE verification_type = 'EXPERIENCE')::bigint AS experience_count
FROM stress_usage_rows
GROUP BY submitted_at::date;

CREATE TEMP TABLE stress_actual_verification_day ON COMMIT DROP AS
SELECT
  vr.submitted_at::date AS business_date,
  COUNT(*) FILTER (
    WHERE vr.record_status = 'APPROVED'
      AND vr.verification_type IN ('NORMAL', 'SUPPLEMENT')
  )::bigint AS normal_count,
  COUNT(*) FILTER (
    WHERE vr.record_status = 'APPROVED'
      AND vr.verification_type = 'EXPERIENCE'
  )::bigint AS experience_count
FROM public.verification_records vr
JOIN stress_customer_map c ON c.customer_id = vr.customer_id
GROUP BY vr.submitted_at::date;

SELECT pg_temp.stress_assert_eq(
  '50 daily verification buckets',
  (SELECT COUNT(*) FROM stress_actual_verification_day),
  50
);
SELECT pg_temp.stress_assert_eq(
  'daily time-bucket statistics',
  (
    SELECT COUNT(*)
    FROM stress_expected_verification_day e
    FULL OUTER JOIN stress_actual_verification_day a USING (business_date)
    WHERE e.business_date IS NULL
       OR a.business_date IS NULL
       OR a.normal_count IS DISTINCT FROM e.normal_count
       OR a.experience_count IS DISTINCT FROM e.experience_count
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'last seven inclusive business days',
  (
    SELECT COUNT(*)
    FROM public.verification_records vr
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
    JOIN stress_params p ON TRUE
    WHERE vr.record_status = 'APPROVED'
      AND vr.submitted_at >= p.run_anchor - INTERVAL '6 days'
      AND vr.submitted_at < p.run_anchor + INTERVAL '1 day'
  ),
  210000
);

SELECT pg_temp.stress_assert_eq(
  'last thirty inclusive business days',
  (
    SELECT COUNT(*)
    FROM public.verification_records vr
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
    JOIN stress_params p ON TRUE
    WHERE vr.record_status = 'APPROVED'
      AND vr.submitted_at >= p.run_anchor - INTERVAL '29 days'
      AND vr.submitted_at < p.run_anchor + INTERVAL '1 day'
  ),
  900000
);

-- ---------------------------------------------------------------------------
-- 12) No-photo and product-immutability guarantees
-- ---------------------------------------------------------------------------
SELECT pg_temp.stress_assert_eq(
  'verification face request ids remain empty',
  (
    SELECT COUNT(*)
    FROM public.verification_records vr
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
    WHERE vr.face_request_id IS NOT NULL
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'no verification photo evidence rows were written',
  (
    SELECT COUNT(*)
    FROM public.verification_photos vp
    JOIN public.verification_records vr ON vr.id = vp.verification_id
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'no verification photo event rows were written',
  (
    SELECT COUNT(*)
    FROM public.verification_photo_events event
    JOIN public.verification_records vr ON vr.id = event.verification_id
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'bulk recharge rows created no synthetic status history',
  (
    SELECT COUNT(*)
    FROM public.record_status_history history
    JOIN public.recharge_records rr
      ON history.record_type = 'RECHARGE'
     AND history.record_id = rr.id
    JOIN stress_customer_map c ON c.customer_id = rr.customer_id
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'bulk verification rows created no synthetic status history',
  (
    SELECT COUNT(*)
    FROM public.record_status_history history
    JOIN public.verification_records vr
      ON history.record_type = 'VERIFICATION'
     AND history.record_id = vr.id
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'bulk verification rows created no device signals',
  (
    SELECT COUNT(*)
    FROM public.device_signal_outbox signal
    JOIN public.verification_records vr ON vr.id = signal.verification_id
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
  ),
  0
);

SELECT pg_temp.stress_assert_eq(
  'product inventory row count remains unchanged',
  (SELECT COUNT(*) FROM public.products),
  (SELECT row_count FROM stress_product_inventory_before)
);
SELECT pg_temp.stress_assert_true(
  'product inventory content remains unchanged',
  (
    SELECT before.fingerprint = after.fingerprint
    FROM stress_product_inventory_before before
    CROSS JOIN LATERAL (
      SELECT MD5(COALESCE(STRING_AGG(TO_JSONB(p)::text, '|' ORDER BY p.id), '')) AS fingerprint
      FROM public.products p
    ) after
  )
);

-- ---------------------------------------------------------------------------
-- 13) Correct full-scope statistics query plan (no recharge x verification join)
-- ---------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
WITH recharge AS (
  SELECT
    rr.store_id,
    rr.product_id,
    SUM(rr.unit_count) FILTER (
      WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'NEW'
    ) AS recharge_units,
    SUM(rr.unit_count) FILTER (
      WHERE rr.record_status = 'APPROVED' AND rr.recharge_type = 'REFUND'
    ) AS refund_units
  FROM public.recharge_records rr
  JOIN stress_customer_map c ON c.customer_id = rr.customer_id
  GROUP BY rr.store_id, rr.product_id
), verification AS (
  SELECT
    vr.store_id,
    vr.product_id,
    SUM(vr.unit_count) FILTER (
      WHERE vr.record_status = 'APPROVED'
        AND vr.verification_type IN ('NORMAL', 'SUPPLEMENT')
    ) AS normal_verifications,
    SUM(vr.unit_count) FILTER (
      WHERE vr.record_status = 'APPROVED'
        AND vr.verification_type = 'EXPERIENCE'
    ) AS experience_verifications
  FROM public.verification_records vr
  JOIN stress_customer_map c ON c.customer_id = vr.customer_id
  GROUP BY vr.store_id, vr.product_id
), balances AS (
  SELECT
    c.store_id,
    b.product_id,
    SUM(b.remaining_count) AS remaining_units
  FROM public.customer_product_balances b
  JOIN stress_customer_map c ON c.customer_id = b.customer_id
  GROUP BY c.store_id, b.product_id
)
SELECT
  s.store_id,
  p.product_id,
  r.recharge_units,
  COALESCE(r.refund_units, 0) AS refund_units,
  v.normal_verifications,
  v.experience_verifications,
  b.remaining_units
FROM stress_store_map s
CROSS JOIN stress_product_map p
JOIN recharge r ON r.store_id = s.store_id AND r.product_id = p.product_id
JOIN verification v ON v.store_id = s.store_id AND v.product_id = p.product_id
JOIN balances b ON b.store_id = s.store_id AND b.product_id = p.product_id
ORDER BY s.store_id, p.product_id;

-- A compact receipt is returned by the SQL editor before the transaction is
-- committed. Reaching this SELECT means every preceding assertion succeeded.
SELECT
  p.run_tag,
  p.run_anchor,
  (SELECT COUNT(*) FROM stress_store_map) AS stores,
  (SELECT COUNT(*) FROM stress_teacher_map) AS teachers,
  (SELECT COUNT(*) FROM stress_customer_map) AS customers,
  (SELECT COUNT(*) FROM stress_product_map) AS existing_products_used,
  (
    SELECT COUNT(*)
    FROM public.recharge_records rr
    JOIN stress_customer_map c ON c.customer_id = rr.customer_id
    WHERE rr.recharge_type = 'NEW'
  ) AS recharge_documents,
  (
    SELECT COUNT(*)
    FROM public.recharge_records rr
    JOIN stress_customer_map c ON c.customer_id = rr.customer_id
    WHERE rr.recharge_type = 'REFUND'
  ) AS refund_documents,
  (
    SELECT COUNT(*)
    FROM public.verification_records vr
    JOIN stress_customer_map c ON c.customer_id = vr.customer_id
  ) AS verification_documents
FROM stress_params p;

COMMIT;

-- CloudBase SQL editor-compatible large-scale statistics stress test.
--
-- Why this file is phased:
-- The CloudBase SQL editor cancels a single query after roughly 45 seconds.
-- The earlier monolithic test is intentionally atomic, but 1,500,000 inserts
-- exceed that UI limit.  Run the phases below separately, in order.  Each
-- verification batch is independently atomic: either all 50,000 rows commit
-- with the four expensive summary triggers restored, or none of that batch
-- commits.
--
-- This run is deliberately tagged LSG20260820A.  Do not run it alongside
-- normal application traffic.  The companion clear script must complete first.

-- ===========================================================================
-- PHASE 1 — run once: build 100 stores, 100 teachers, 10,000 customers and
-- 33,000 recharge/refund documents.  Expected runtime: well below 45 seconds.
-- ===========================================================================
BEGIN;
SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '30s';

DO $preflight$
DECLARE
  remaining bigint;
  hq_count bigint;
  product_count bigint;
BEGIN
  SELECT COUNT(*) INTO hq_count FROM public.staff_accounts WHERE role_code = 'hq';
  SELECT COUNT(*) INTO product_count FROM public.products WHERE product_status = 'ACTIVE';
  SELECT COUNT(*) INTO remaining
  FROM public.staff_accounts
  WHERE role_code <> 'hq'
     OR staff_code LIKE 'LSG20260820A%';
  IF hq_count < 1 OR product_count < 3 OR remaining <> 0 THEN
    RAISE EXCEPTION
      'batched stress preflight failed: need HQ-only accounts, 3 active products, and no prior run (HQ %, products %, unexpected accounts %)',
      hq_count, product_count, remaining;
  END IF;
  IF EXISTS (SELECT 1 FROM public.stores)
     OR EXISTS (SELECT 1 FROM public.teachers)
     OR EXISTS (SELECT 1 FROM public.customers)
     OR EXISTS (SELECT 1 FROM public.recharge_records)
     OR EXISTS (SELECT 1 FROM public.verification_records) THEN
    RAISE EXCEPTION 'batched stress preflight failed: operational tables are not empty';
  END IF;
END;
$preflight$;

-- The original test verified these exact trigger names before changing them.
DO $trigger_preflight$
BEGIN
  IF (
    SELECT COUNT(*) FROM pg_catalog.pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
      AND ((t.tgrelid = 'public.recharge_records'::regclass
             AND t.tgname IN ('trg_recharge_refresh_customer_balance', 'trg_recharge_status_history'))
        OR (t.tgrelid = 'public.verification_records'::regclass
             AND t.tgname IN ('trg_verification_refresh_customer_balance', 'trg_verification_status_history')))
  ) <> 4 THEN
    RAISE EXCEPTION 'batched stress preflight failed: the four bulk triggers are not all enabled';
  END IF;
END;
$trigger_preflight$;

CREATE TEMP TABLE _lsg_products ON COMMIT DROP AS
SELECT ROW_NUMBER() OVER (ORDER BY id)::integer AS product_idx, id AS product_id
FROM public.products
WHERE product_status = 'ACTIVE'
ORDER BY id
LIMIT 3;

CREATE TEMP TABLE _lsg_store_inputs ON COMMIT DROP AS
SELECT
  i AS store_idx,
  FORMAT('LSG20260820AS%s', LPAD(i::text, 3, '0')) AS staff_code,
  FORMAT('LSG20260820A_store_%s', LPAD(i::text, 3, '0')) AS auth_uid,
  ('199' || LPAD(i::text, 8, '0'))::char(11) AS phone
FROM generate_series(1, 100) AS i;

CREATE TEMP TABLE _lsg_teacher_inputs ON COMMIT DROP AS
SELECT
  i AS teacher_idx,
  FORMAT('LSG20260820AT%s', LPAD(i::text, 3, '0')) AS staff_code,
  FORMAT('LSG20260820A_teacher_%s', LPAD(i::text, 3, '0')) AS auth_uid,
  ('199' || LPAD((100 + i)::text, 8, '0'))::char(11) AS phone
FROM generate_series(1, 100) AS i;

INSERT INTO public.staff_accounts
  (staff_code, auth_uid, phone, staff_name, role_code, account_status)
SELECT staff_code, auth_uid, phone, FORMAT('LSG Store Staff %s', store_idx), 'store', 'ACTIVE'
FROM _lsg_store_inputs;

INSERT INTO public.stores
  (store_code, store_name, province, city, district, address_detail, store_account_id, store_status)
SELECT
  FORMAT('LSG20260820AS%s', LPAD(i.store_idx::text, 3, '0')),
  FORMAT('LSG Store %s', LPAD(i.store_idx::text, 3, '0')),
  '测试省', '测试市', '测试区', FORMAT('LSG Address %s', i.store_idx), account.id, 'ACTIVE'
FROM _lsg_store_inputs i
JOIN public.staff_accounts account ON account.staff_code = i.staff_code;

INSERT INTO public.staff_accounts
  (staff_code, auth_uid, phone, staff_name, role_code, account_status)
SELECT staff_code, auth_uid, phone, FORMAT('LSG Teacher %s', teacher_idx), 'teacher', 'ACTIVE'
FROM _lsg_teacher_inputs;

CREATE TEMP TABLE _lsg_stores ON COMMIT DROP AS
SELECT
  i.store_idx,
  s.id AS store_id,
  s.store_account_id
FROM _lsg_store_inputs i
JOIN public.staff_accounts account ON account.staff_code = i.staff_code
JOIN public.stores s ON s.store_account_id = account.id;

CREATE TEMP TABLE _lsg_teachers ON COMMIT DROP AS
SELECT
  i.teacher_idx,
  teacher.id AS teacher_id
FROM _lsg_teacher_inputs i
JOIN public.staff_accounts account ON account.staff_code = i.staff_code
JOIN public.teachers teacher ON teacher.staff_account_id = account.id;

INSERT INTO public.customers
  (customer_code, customer_name, birth_date, created_store_id, customer_status, notes)
SELECT
  FORMAT('LSG20260820AC%s%s', LPAD(s.store_idx::text, 3, '0'), LPAD(c.customer_seq::text, 3, '0')),
  FORMAT('LSG Customer %s-%s', s.store_idx, c.customer_seq),
  (DATE '1980-01-01' + ((s.store_idx * 1000 + c.customer_seq) % 14000))::date,
  s.store_id,
  'ACTIVE',
  'large-scale-no-photo LSG20260820A'
FROM _lsg_stores s
CROSS JOIN generate_series(1, 100) AS c(customer_seq);

CREATE TEMP TABLE _lsg_customer_product ON COMMIT DROP AS
SELECT
  ROW_NUMBER() OVER (ORDER BY customer.id, product.product_id)::integer AS cp_idx,
  s.store_idx,
  s.store_id,
  s.store_account_id,
  customer.id AS customer_id,
  ((SUBSTRING(customer.customer_code FROM 17 FOR 3))::integer) AS customer_seq,
  product.product_idx,
  product.product_id
FROM public.customers customer
JOIN _lsg_stores s ON s.store_id = customer.created_store_id
CROSS JOIN _lsg_products product
WHERE customer.customer_code LIKE 'LSG20260820AC%';

ALTER TABLE public.recharge_records DISABLE TRIGGER trg_recharge_refresh_customer_balance;
ALTER TABLE public.recharge_records DISABLE TRIGGER trg_recharge_status_history;

INSERT INTO public.recharge_records
  (recharge_code, recharge_type, store_id, teacher_id, customer_id, product_id, unit_count,
   record_status, submitted_by_account_id, submitted_at, reviewed_by_account_id, reviewed_at, message)
SELECT
  FORMAT('LSG20260820AR%s', LPAD(cp.cp_idx::text, 5, '0')),
  'NEW', cp.store_id, teacher.teacher_id, cp.customer_id, cp.product_id, 50,
  'APPROVED', cp.store_account_id,
  (CURRENT_DATE - 60 + TIME '12:00'), hq.id, (CURRENT_DATE - 60 + TIME '12:01'),
  'large-scale-no-photo LSG20260820A'
FROM _lsg_customer_product cp
JOIN _lsg_teachers teacher ON teacher.teacher_idx = 1 + MOD(cp.cp_idx * 17, 100)
CROSS JOIN LATERAL (
  SELECT id FROM public.staff_accounts WHERE role_code = 'hq' AND account_status = 'ACTIVE' ORDER BY id LIMIT 1
) hq;

INSERT INTO public.recharge_records
  (recharge_code, recharge_type, store_id, teacher_id, customer_id, product_id, unit_count,
   balance_before_count, balance_after_count, record_status,
   submitted_by_account_id, submitted_at, reviewed_by_account_id, reviewed_at, message)
SELECT
  FORMAT('LSG20260820AF%s', LPAD(cp.cp_idx::text, 5, '0')),
  'REFUND', cp.store_id, teacher.teacher_id, cp.customer_id, cp.product_id, 10,
  5, 0, 'APPROVED', cp.store_account_id,
  (CURRENT_DATE - 20 + TIME '12:00'), hq.id, (CURRENT_DATE - 20 + TIME '12:01'),
  'large-scale-no-photo LSG20260820A'
FROM _lsg_customer_product cp
JOIN _lsg_teachers teacher ON teacher.teacher_idx = 1 + MOD(cp.cp_idx * 29, 100)
CROSS JOIN LATERAL (
  SELECT id FROM public.staff_accounts WHERE role_code = 'hq' AND account_status = 'ACTIVE' ORDER BY id LIMIT 1
) hq
WHERE MOD(cp.customer_seq, 10) = 0;

ALTER TABLE public.recharge_records ENABLE TRIGGER trg_recharge_refresh_customer_balance;
ALTER TABLE public.recharge_records ENABLE TRIGGER trg_recharge_status_history;

DO $assert_setup$
BEGIN
  IF (SELECT COUNT(*) FROM _lsg_stores) <> 100
     OR (SELECT COUNT(*) FROM _lsg_teachers) <> 100
     OR (SELECT COUNT(*) FROM public.customers WHERE customer_code LIKE 'LSG20260820AC%') <> 10000
     OR (SELECT COUNT(*) FROM public.recharge_records WHERE recharge_code LIKE 'LSG20260820AR%') <> 30000
     OR (SELECT COUNT(*) FROM public.recharge_records WHERE recharge_code LIKE 'LSG20260820AF%') <> 3000 THEN
    RAISE EXCEPTION 'batched stress setup assertion failed';
  END IF;
END;
$assert_setup$;
COMMIT;

-- ===========================================================================
-- PHASE 2 — run this same query once per 50,000-row batch.  Replace the two
-- numbers in _lsg_batch.  Required ranges are:
--  1-50000, 50001-100000, ..., 1450001-1500000.
-- ===========================================================================
BEGIN;
SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '30s';

CREATE TEMP TABLE _lsg_batch ON COMMIT DROP AS
SELECT 1::integer AS start_seq, 50000::integer AS end_seq; -- REPLACE BOTH VALUES

DO $batch_preflight$
DECLARE expected_count bigint;
BEGIN
  SELECT end_seq - start_seq + 1 INTO expected_count FROM _lsg_batch;
  IF expected_count <= 0 OR expected_count > 50000 THEN
    RAISE EXCEPTION 'batch size must be 1..50000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.verification_records record
    JOIN _lsg_batch batch ON record.verification_code BETWEEN
      FORMAT('LSG20260820AV%s', LPAD(batch.start_seq::text, 7, '0')) AND
      FORMAT('LSG20260820AV%s', LPAD(batch.end_seq::text, 7, '0'))
  ) THEN
    RAISE EXCEPTION 'batch already committed; do not rerun it';
  END IF;
END;
$batch_preflight$;

ALTER TABLE public.verification_records DISABLE TRIGGER trg_verification_refresh_customer_balance;
ALTER TABLE public.verification_records DISABLE TRIGGER trg_verification_status_history;

WITH
products AS (
  SELECT ROW_NUMBER() OVER (ORDER BY id)::integer AS product_idx, id AS product_id
  FROM public.products WHERE product_status = 'ACTIVE' ORDER BY id LIMIT 3
),
stores AS (
  SELECT s.id AS store_id, s.store_account_id,
         SUBSTRING(account.staff_code FROM 14 FOR 3)::integer AS store_idx
  FROM public.stores s
  JOIN public.staff_accounts account ON account.id = s.store_account_id
  WHERE account.staff_code LIKE 'LSG20260820AS%'
),
customers AS (
  SELECT ROW_NUMBER() OVER (ORDER BY customer.id, product.product_id)::integer AS cp_idx,
         store.store_id, store.store_account_id, customer.id AS customer_id,
         product.product_idx, product.product_id
  FROM public.customers customer
  JOIN stores store ON store.store_id = customer.created_store_id
  CROSS JOIN products product
  WHERE customer.customer_code LIKE 'LSG20260820AC%'
),
teachers AS (
  SELECT ROW_NUMBER() OVER (ORDER BY account.id)::integer AS teacher_idx, teacher.id AS teacher_id
  FROM public.teachers teacher
  JOIN public.staff_accounts account ON account.id = teacher.staff_account_id
  WHERE account.staff_code LIKE 'LSG20260820AT%'
),
hq AS (
  SELECT id AS reviewer_id FROM public.staff_accounts
  WHERE role_code = 'hq' AND account_status = 'ACTIVE' ORDER BY id LIMIT 1
),
rows AS (
  SELECT
    seq AS global_seq,
    ((seq - 1) / 50 + 1)::integer AS cp_idx,
    (MOD(seq - 1, 50) + 1)::integer AS use_no
  FROM _lsg_batch, LATERAL generate_series(start_seq, end_seq) AS seq
)
INSERT INTO public.verification_records
  (verification_code, verification_type, store_id, teacher_id, customer_id, product_id,
   unit_count, record_status, submitted_by_account_id, reviewed_by_account_id,
   submitted_at, reviewed_at, message)
SELECT
  FORMAT('LSG20260820AV%s', LPAD(row.global_seq::text, 7, '0')),
  CASE WHEN MOD(row.use_no + MOD(customer.cp_idx, 10), 10) = 0 THEN 'EXPERIENCE' ELSE 'NORMAL' END,
  customer.store_id,
  teacher.teacher_id,
  customer.customer_id,
  customer.product_id,
  1, 'APPROVED', customer.store_account_id, hq.reviewer_id,
  (CURRENT_DATE - (row.use_no - 1) + TIME '12:00'),
  (CURRENT_DATE - (row.use_no - 1) + TIME '12:01'),
  'large-scale-no-photo LSG20260820A'
FROM rows row
JOIN customers customer ON customer.cp_idx = row.cp_idx
JOIN teachers teacher ON teacher.teacher_idx = 1 + MOD(row.global_seq * 17 + row.cp_idx * 5, 100)
CROSS JOIN hq;

ALTER TABLE public.verification_records ENABLE TRIGGER trg_verification_refresh_customer_balance;
ALTER TABLE public.verification_records ENABLE TRIGGER trg_verification_status_history;

DO $assert_batch$
DECLARE expected_count bigint;
DECLARE actual_count bigint;
BEGIN
  SELECT end_seq - start_seq + 1 INTO expected_count FROM _lsg_batch;
  SELECT COUNT(*) INTO actual_count
  FROM public.verification_records record
  JOIN _lsg_batch batch ON record.verification_code BETWEEN
    FORMAT('LSG20260820AV%s', LPAD(batch.start_seq::text, 7, '0')) AND
    FORMAT('LSG20260820AV%s', LPAD(batch.end_seq::text, 7, '0'));
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'batch insert assertion failed: expected %, actual %', expected_count, actual_count;
  END IF;
END;
$assert_batch$;
COMMIT;

-- ===========================================================================
-- PHASE 3 — run once after all 30 batches: rebuild cached balances and state.
-- ===========================================================================
BEGIN;
SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '30min';

DO $final_preflight$
BEGIN
  IF (SELECT COUNT(*) FROM public.verification_records WHERE verification_code LIKE 'LSG20260820AV%') <> 1500000 THEN
    RAISE EXCEPTION 'finalize requires all 1,500,000 verification rows';
  END IF;
END;
$final_preflight$;

WITH products AS (
  SELECT id AS product_id FROM public.products WHERE product_status = 'ACTIVE' ORDER BY id LIMIT 3
),
customers AS (
  SELECT customer.id AS customer_id,
         SUBSTRING(customer.customer_code FROM 17 FOR 3)::integer AS customer_seq
  FROM public.customers customer
  WHERE customer.customer_code LIKE 'LSG20260820AC%'
)
INSERT INTO public.customer_product_balances
  (customer_id, product_id, total_recharge_count, total_verification_count, remaining_count, updated_at)
SELECT
  customer.customer_id, product.product_id,
  CASE WHEN MOD(customer.customer_seq, 10) = 0 THEN 40 ELSE 50 END,
  45,
  CASE WHEN MOD(customer.customer_seq, 10) = 0 THEN 0 ELSE 5 END,
  CLOCK_TIMESTAMP()
FROM customers customer CROSS JOIN products product;

UPDATE public.customers customer
SET
  total_recharge_count = CASE WHEN MOD(SUBSTRING(customer.customer_code FROM 17 FOR 3)::integer, 10) = 0 THEN 120 ELSE 150 END,
  total_verification_count = 150,
  total_experience_count = 15,
  latest_recharge_at = (CURRENT_DATE - 60 + TIME '12:00'),
  latest_verification_at = (CURRENT_DATE + TIME '12:00'),
  customer_process_status = 'RECHARGED_WITH_CONSUMPTION',
  updated_at = CLOCK_TIMESTAMP()
WHERE customer.customer_code LIKE 'LSG20260820AC%';

ANALYZE public.recharge_records;
ANALYZE public.verification_records;
ANALYZE public.customer_product_balances;
COMMIT;

-- ===========================================================================
-- PHASE 4 — lightweight correctness receipt. Run after phase 3.
-- ===========================================================================
WITH
customers AS (
  SELECT id, created_store_id,
         SUBSTRING(customer_code FROM 17 FOR 3)::integer AS customer_seq
  FROM public.customers WHERE customer_code LIKE 'LSG20260820AC%'
),
verification AS (
  SELECT verification_type, store_id, teacher_id, customer_id, product_id, submitted_at
  FROM public.verification_records WHERE verification_code LIKE 'LSG20260820AV%'
),
receipt AS (
  SELECT
    (SELECT COUNT(*) FROM public.stores store JOIN public.staff_accounts a ON a.id = store.store_account_id WHERE a.staff_code LIKE 'LSG20260820AS%') AS stores,
    (SELECT COUNT(*) FROM public.teachers teacher JOIN public.staff_accounts a ON a.id = teacher.staff_account_id WHERE a.staff_code LIKE 'LSG20260820AT%') AS teachers,
    (SELECT COUNT(*) FROM customers) AS customers,
    (SELECT COUNT(*) FROM public.recharge_records WHERE recharge_code LIKE 'LSG20260820AR%') AS recharges,
    (SELECT COUNT(*) FROM public.recharge_records WHERE recharge_code LIKE 'LSG20260820AF%') AS refunds,
    (SELECT COUNT(*) FROM verification) AS verifications,
    (SELECT COUNT(*) FROM verification WHERE verification_type = 'NORMAL') AS normal_verifications,
    (SELECT COUNT(*) FROM verification WHERE verification_type = 'EXPERIENCE') AS experience_verifications,
    (SELECT COUNT(*) FROM public.verification_photos photo JOIN public.verification_records record ON record.id = photo.verification_id WHERE record.verification_code LIKE 'LSG20260820AV%') AS photo_rows,
    (SELECT COUNT(*) FROM public.customer_product_balances balance JOIN customers customer ON customer.id = balance.customer_id) AS balance_rows,
    (SELECT COUNT(*) FROM public.customers WHERE customer_code LIKE 'LSG20260820AC%' AND profile_photo_file_id IS NOT NULL) AS profile_photo_rows
)
SELECT *,
  stores = 100 AND teachers = 100 AND customers = 10000 AND recharges = 30000 AND refunds = 3000
  AND verifications = 1500000 AND normal_verifications = 1350000 AND experience_verifications = 150000
  AND photo_rows = 0 AND balance_rows = 30000 AND profile_photo_rows = 0 AS basic_pass
FROM receipt;

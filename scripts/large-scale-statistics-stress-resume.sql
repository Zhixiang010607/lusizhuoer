-- Resumable CloudBase SQL-editor load for the already-created LSG20260820A
-- identities and customers.
--
-- The live database was inspected before this file was written.  It has the
-- legacy four bulk triggers below, and does NOT have the later PENDING-only
-- guard triggers.  Every phase therefore fails closed if that live shape has
-- changed rather than silently bypassing a newer workflow rule.
--
-- Run each numbered phase as a separate SQL-editor execution.  Do not select
-- the entire file and run it at once.  The 100 verification batches contain
-- 15,000 rows each (100 customers x 3 products x 50 uses), which is small
-- enough to stay below the editor timeout.  A timed-out transaction rolls
-- back both its inserts and its temporary trigger changes.
--
-- If the editor reports an aborted transaction after an error, run ROLLBACK;
-- by itself, then retry the same phase or batch.  Verification batches are
-- idempotent; phases 0 and 1 deliberately refuse a second successful run.

-- ===========================================================================
-- PHASE 0 -- Run once now.  Freeze the timestamp, reviewer and three product
-- IDs after the store/teacher/customer setup has committed successfully.
-- ===========================================================================
BEGIN;
SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.lsg_stress_runs (
  run_tag VARCHAR(16) PRIMARY KEY,
  run_anchor TIMESTAMPTZ NOT NULL,
  reviewer_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  product_inventory_count BIGINT NOT NULL,
  product_inventory_fingerprint TEXT NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (status IN (
    'MANIFEST_READY', 'RECHARGES_READY', 'LOADING', 'COMPLETE'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS public.lsg_stress_run_products (
  run_tag VARCHAR(16) NOT NULL REFERENCES public.lsg_stress_runs(run_tag)
    ON DELETE CASCADE,
  product_idx SMALLINT NOT NULL CHECK (product_idx BETWEEN 1 AND 3),
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  PRIMARY KEY (run_tag, product_idx),
  UNIQUE (run_tag, product_id)
);

CREATE TABLE IF NOT EXISTS public.lsg_stress_run_batches (
  run_tag VARCHAR(16) NOT NULL REFERENCES public.lsg_stress_runs(run_tag)
    ON DELETE CASCADE,
  batch_no INTEGER NOT NULL CHECK (batch_no BETWEEN 1 AND 100),
  expected_rows INTEGER NOT NULL,
  actual_rows INTEGER NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (run_tag, batch_no)
);

DO $phase0_preflight$
DECLARE
  active_hq_count BIGINT;
  active_product_count BIGINT;
  store_count BIGINT;
  teacher_count BIGINT;
  customer_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.lsg_stress_runs
    WHERE run_tag = 'LSG20260820A'
  ) THEN
    RAISE EXCEPTION 'LSG20260820A already has a persisted manifest';
  END IF;

  SELECT COUNT(*) INTO active_hq_count
  FROM public.staff_accounts
  WHERE role_code = 'hq' AND account_status = 'ACTIVE';
  SELECT COUNT(*) INTO active_product_count
  FROM public.products
  WHERE product_status = 'ACTIVE';
  SELECT COUNT(*) INTO store_count
  FROM public.stores AS s
  JOIN public.staff_accounts AS a ON a.id = s.store_account_id
  WHERE LEFT(a.staff_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AS';
  SELECT COUNT(*) INTO teacher_count
  FROM public.teachers AS t
  JOIN public.staff_accounts AS a ON a.id = t.staff_account_id
  WHERE LEFT(a.staff_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AT';
  SELECT COUNT(*) INTO customer_count
  FROM public.customers
  WHERE LEFT(customer_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AC';

  IF active_hq_count < 1 OR active_product_count < 3
     OR store_count <> 100 OR teacher_count <> 100 OR customer_count <> 10000 THEN
    RAISE EXCEPTION
      'phase 0 preflight failed (active HQ %, active products %, stores %, teachers %, customers %)',
      active_hq_count, active_product_count, store_count, teacher_count, customer_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.recharge_records
    WHERE LEFT(recharge_code, LENGTH('LSG20260820A') + 1)
      IN ('LSG20260820AR', 'LSG20260820AF')
  ) OR EXISTS (
    SELECT 1 FROM public.verification_records
    WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
  ) THEN
    RAISE EXCEPTION 'phase 0 preflight failed: tagged fact rows already exist';
  END IF;
END;
$phase0_preflight$;

INSERT INTO public.lsg_stress_runs
  (run_tag, run_anchor, reviewer_account_id, product_inventory_count,
   product_inventory_fingerprint, status)
SELECT
  'LSG20260820A',
  DATE_TRUNC('minute', CLOCK_TIMESTAMP()) - INTERVAL '2 minutes',
  reviewer.id,
  inventory.row_count,
  inventory.fingerprint,
  'MANIFEST_READY'
FROM (
  SELECT id
  FROM public.staff_accounts
  WHERE role_code = 'hq' AND account_status = 'ACTIVE'
  ORDER BY id
  LIMIT 1
) AS reviewer
CROSS JOIN LATERAL (
  SELECT
    COUNT(*)::BIGINT AS row_count,
    MD5(COALESCE(STRING_AGG(TO_JSONB(p)::TEXT, '|' ORDER BY p.id), '')) AS fingerprint
  FROM public.products AS p
) AS inventory;

INSERT INTO public.lsg_stress_run_products (run_tag, product_idx, product_id)
SELECT
  'LSG20260820A',
  ROW_NUMBER() OVER (ORDER BY selected.id)::SMALLINT,
  selected.id
FROM (
  SELECT id
  FROM public.products
  WHERE product_status = 'ACTIVE'
  ORDER BY id
  LIMIT 3
) AS selected;

SELECT run_tag, run_anchor, reviewer_account_id, status
FROM public.lsg_stress_runs
WHERE run_tag = 'LSG20260820A';
COMMIT;

-- ===========================================================================
-- PHASE 1 -- Run once after phase 0.  Insert and approve the 30,000 NEW and
-- 3,000 REFUND records.  The known expensive balance/history triggers are
-- disabled only inside this transaction and restored before COMMIT.
-- ===========================================================================
BEGIN;
SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '35s';
SET LOCAL lock_timeout = '5s';

DO $phase1_preflight$
DECLARE
  run_status TEXT;
  trigger_count BIGINT;
BEGIN
  SELECT status INTO run_status
  FROM public.lsg_stress_runs
  WHERE run_tag = 'LSG20260820A'
  FOR UPDATE;
  IF run_status NOT IN ('MANIFEST_READY', 'LOADING') THEN
    RAISE EXCEPTION 'phase 1 requires MANIFEST_READY (or recovery-seeded LOADING), found %', run_status;
  END IF;
  IF run_status = 'LOADING' AND EXISTS (
    SELECT 1
    FROM public.recharge_records
    WHERE LEFT(recharge_code, LENGTH('LSG20260820A') + 1)
      IN ('LSG20260820AR', 'LSG20260820AF')
  ) THEN
    RAISE EXCEPTION 'phase 1 recovery path refuses to overwrite existing tagged recharge facts';
  END IF;

  SELECT COUNT(*) INTO trigger_count
  FROM pg_catalog.pg_trigger AS t
  WHERE NOT t.tgisinternal
    AND t.tgenabled = 'O'
    AND t.tgrelid = 'public.recharge_records'::REGCLASS
    AND t.tgname IN (
      'trg_recharge_refresh_customer_balance',
      'trg_recharge_status_history'
    );
  IF trigger_count <> 2 THEN
    RAISE EXCEPTION
      'phase 1 needs the two inspected live recharge bulk triggers enabled, found %',
      trigger_count;
  END IF;
END;
$phase1_preflight$;

CREATE TEMP TABLE _lsg_recharge_rows ON COMMIT DROP AS
WITH run AS (
  SELECT * FROM public.lsg_stress_runs WHERE run_tag = 'LSG20260820A'
), store_customer AS (
  SELECT
    s.id AS store_id,
    s.store_account_id,
    c.id AS customer_id,
    LEFT(RIGHT(c.customer_code, 6), 3)::INTEGER AS store_idx,
    RIGHT(c.customer_code, 3)::INTEGER AS customer_seq
  FROM run AS r
  JOIN public.customers AS c
    ON LEFT(c.customer_code, LENGTH(r.run_tag) + 1) = r.run_tag || 'C'
  JOIN public.stores AS s ON s.id = c.created_store_id
), teacher_map AS (
  SELECT
    RIGHT(a.staff_code, 3)::INTEGER AS teacher_idx,
    t.id AS teacher_id
  FROM run AS r
  JOIN public.staff_accounts AS a
    ON LEFT(a.staff_code, LENGTH(r.run_tag) + 1) = r.run_tag || 'T'
  JOIN public.teachers AS t ON t.staff_account_id = a.id
)
SELECT
  ROW_NUMBER() OVER (ORDER BY c.customer_id, p.product_idx)::INTEGER AS cp_idx,
  c.store_id,
  c.store_account_id,
  c.customer_id,
  c.store_idx,
  c.customer_seq,
  p.product_idx,
  p.product_id,
  new_teacher.teacher_id AS new_teacher_id,
  refund_teacher.teacher_id AS refund_teacher_id,
  r.run_tag,
  r.run_anchor,
  r.reviewer_account_id
FROM run AS r
JOIN store_customer AS c ON TRUE
JOIN public.lsg_stress_run_products AS p ON p.run_tag = r.run_tag
JOIN teacher_map AS new_teacher ON new_teacher.teacher_idx = 1 + MOD(
  c.store_idx * 31 + c.customer_seq * 7 + p.product_idx * 13,
  100
)
JOIN teacher_map AS refund_teacher ON refund_teacher.teacher_idx = 1 + MOD(
  c.store_idx * 19 + c.customer_seq * 23 + p.product_idx * 29,
  100
);

DO $phase1_row_preflight$
BEGIN
  IF (SELECT COUNT(*) FROM _lsg_recharge_rows) <> 30000 THEN
    RAISE EXCEPTION 'phase 1 expected 30,000 customer/product rows';
  END IF;
END;
$phase1_row_preflight$;

ALTER TABLE public.recharge_records
  DISABLE TRIGGER trg_recharge_refresh_customer_balance;
ALTER TABLE public.recharge_records
  DISABLE TRIGGER trg_recharge_status_history;

INSERT INTO public.recharge_records
  (recharge_code, recharge_type, store_id, teacher_id, customer_id, product_id,
   unit_count, record_status, submitted_by_account_id, submitted_at,
   reviewed_by_account_id, reviewed_at, message)
SELECT
  FORMAT('%sR%s', row.run_tag, LPAD(row.cp_idx::TEXT, 5, '0')),
  'NEW', row.store_id, row.new_teacher_id, row.customer_id, row.product_id,
  50, 'APPROVED', row.store_account_id, row.run_anchor - INTERVAL '60 days',
  row.reviewer_account_id, row.run_anchor - INTERVAL '60 days' + INTERVAL '1 minute',
  FORMAT('large-scale-no-photo %s', row.run_tag)
FROM _lsg_recharge_rows AS row;

INSERT INTO public.recharge_records
  (recharge_code, recharge_type, store_id, teacher_id, customer_id, product_id,
   unit_count, balance_before_count, balance_after_count, record_status,
   submitted_by_account_id, submitted_at, reviewed_by_account_id, reviewed_at,
   message)
SELECT
  FORMAT('%sF%s', row.run_tag, LPAD(row.cp_idx::TEXT, 5, '0')),
  'REFUND', row.store_id, row.refund_teacher_id, row.customer_id, row.product_id,
  10, 5, 0, 'APPROVED', row.store_account_id,
  row.run_anchor - INTERVAL '20 days', row.reviewer_account_id,
  row.run_anchor - INTERVAL '20 days' + INTERVAL '1 minute',
  FORMAT('large-scale-no-photo %s', row.run_tag)
FROM _lsg_recharge_rows AS row
WHERE MOD(row.customer_seq, 10) = 0;

ALTER TABLE public.recharge_records
  ENABLE TRIGGER trg_recharge_refresh_customer_balance;
ALTER TABLE public.recharge_records
  ENABLE TRIGGER trg_recharge_status_history;

DO $phase1_assert$
DECLARE
  new_count BIGINT;
  refund_count BIGINT;
  trigger_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO new_count
  FROM public.recharge_records
  WHERE LEFT(recharge_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AR'
    AND recharge_type = 'NEW' AND record_status = 'APPROVED';
  SELECT COUNT(*) INTO refund_count
  FROM public.recharge_records
  WHERE LEFT(recharge_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AF'
    AND recharge_type = 'REFUND' AND record_status = 'APPROVED'
    AND balance_before_count = 5 AND balance_after_count = 0;
  SELECT COUNT(*) INTO trigger_count
  FROM pg_catalog.pg_trigger AS t
  WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
    AND t.tgrelid = 'public.recharge_records'::REGCLASS
    AND t.tgname IN (
      'trg_recharge_refresh_customer_balance',
      'trg_recharge_status_history'
    );
  IF new_count <> 30000 OR refund_count <> 3000 OR trigger_count <> 2 THEN
    RAISE EXCEPTION
      'phase 1 assertion failed (new %, refund %, enabled triggers %)',
      new_count, refund_count, trigger_count;
  END IF;
END;
$phase1_assert$;

UPDATE public.lsg_stress_runs
SET status = 'RECHARGES_READY', updated_at = CLOCK_TIMESTAMP()
WHERE run_tag = 'LSG20260820A';
COMMIT;

-- ===========================================================================
-- PHASE 2 -- Run this block 100 times, changing only batch_no below from 1
-- through 100.  Each execution commits exactly one 15,000-row batch.
-- ===========================================================================
BEGIN;
SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '35s';
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE _lsg_batch_params ON COMMIT DROP AS
SELECT
  configured.*,
  ((configured.batch_no - 1) * configured.customers_per_batch + 1)::INTEGER
    AS first_customer_ordinal,
  (configured.batch_no * configured.customers_per_batch)::INTEGER
    AS last_customer_ordinal
FROM (
  SELECT
    run.*,
    1::INTEGER AS batch_no, -- CHANGE ONLY THIS VALUE: 1 through 100
    100::INTEGER AS customers_per_batch
  FROM public.lsg_stress_runs AS run
  WHERE run.run_tag = 'LSG20260820A'
) AS configured;

DO $batch_preflight$
DECLARE
  run_status TEXT;
  current_batch INTEGER;
  trigger_count BIGINT;
BEGIN
  SELECT run.status, batch.batch_no INTO run_status, current_batch
  FROM public.lsg_stress_runs AS run
  JOIN _lsg_batch_params AS batch ON TRUE
  WHERE run.run_tag = 'LSG20260820A'
  FOR UPDATE;
  IF run_status NOT IN ('RECHARGES_READY', 'LOADING') THEN
    RAISE EXCEPTION 'verification batch requires RECHARGES_READY or LOADING, found %', run_status;
  END IF;
  IF current_batch NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'batch number must be 1 through 100';
  END IF;
  SELECT COUNT(*) INTO trigger_count
  FROM pg_catalog.pg_trigger AS t
  WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
    AND t.tgrelid = 'public.verification_records'::REGCLASS
    AND t.tgname IN (
      'trg_verification_refresh_customer_balance',
      'trg_verification_status_history'
    );
  IF trigger_count <> 2 THEN
    RAISE EXCEPTION
      'batch % needs the two inspected live verification bulk triggers enabled, found %',
      current_batch, trigger_count;
  END IF;
END;
$batch_preflight$;

CREATE TEMP TABLE _lsg_batch_customer_product ON COMMIT DROP AS
WITH raw_customer_map AS (
  SELECT
    c.id AS customer_id,
    s.id AS store_id,
    s.store_account_id,
    LEFT(RIGHT(c.customer_code, 6), 3)::INTEGER AS store_idx,
    RIGHT(c.customer_code, 3)::INTEGER AS customer_seq
  FROM _lsg_batch_params AS batch
  JOIN public.customers AS c
    ON LEFT(c.customer_code, LENGTH(batch.run_tag) + 1) = batch.run_tag || 'C'
  JOIN public.stores AS s ON s.id = c.created_store_id
), customer_map AS (
  -- Existing batches 1..11 used customer.id order to assign global sequence
  -- numbers.  Keep that ordering so the resumed ranges continue exactly where
  -- those committed rows end, even if the original set-based customer insert
  -- did not happen to allocate IDs in lexical customer_code order.
  SELECT
    raw.*,
    ROW_NUMBER() OVER (ORDER BY raw.customer_id)::INTEGER AS customer_ordinal
  FROM raw_customer_map AS raw
)
SELECT
  c.customer_id,
  c.store_id,
  c.store_account_id,
  c.store_idx,
  c.customer_seq,
  c.customer_ordinal,
  p.product_idx,
  p.product_id
FROM _lsg_batch_params AS batch
JOIN customer_map AS c
  ON c.customer_ordinal BETWEEN batch.first_customer_ordinal
                            AND batch.last_customer_ordinal
JOIN public.lsg_stress_run_products AS p ON p.run_tag = batch.run_tag;

CREATE TEMP TABLE _lsg_batch_rows ON COMMIT DROP AS
WITH teacher_map AS (
  SELECT
    RIGHT(a.staff_code, 3)::INTEGER AS teacher_idx,
    t.id AS teacher_id
  FROM _lsg_batch_params AS batch
  JOIN public.staff_accounts AS a
    ON LEFT(a.staff_code, LENGTH(batch.run_tag) + 1) = batch.run_tag || 'T'
  JOIN public.teachers AS t ON t.staff_account_id = a.id
)
SELECT
  ((cp.customer_ordinal - 1) * 3 * 50
    + (cp.product_idx - 1) * 50 + use_row.use_no)::INTEGER AS global_seq,
  cp.store_id,
  cp.store_account_id,
  cp.customer_id,
  cp.store_idx,
  cp.customer_seq,
  cp.product_idx,
  cp.product_id,
  teacher.teacher_id,
  use_row.use_no,
  CASE
    WHEN MOD(
      (use_row.use_no - 1)::BIGINT
        + ABS(HASHTEXT(cp.customer_id::TEXT || ':' || cp.product_id::TEXT)::BIGINT),
      10
    ) = 0 THEN 'EXPERIENCE'
    ELSE 'NORMAL'
  END::VARCHAR(16) AS verification_type,
  batch.run_tag,
  batch.run_anchor,
  batch.reviewer_account_id
FROM _lsg_batch_params AS batch
JOIN _lsg_batch_customer_product AS cp ON TRUE
CROSS JOIN LATERAL GENERATE_SERIES(1, 50) AS use_row(use_no)
JOIN teacher_map AS teacher ON teacher.teacher_idx = 1 + MOD(
  cp.store_idx * 17 + cp.customer_seq * 11 + cp.product_idx * 5 + use_row.use_no - 1,
  100
);

DO $batch_row_preflight$
BEGIN
  IF (SELECT COUNT(*) FROM _lsg_batch_customer_product) <> 300
     OR (SELECT COUNT(*) FROM _lsg_batch_rows) <> 15000
     OR EXISTS (
       SELECT 1 FROM _lsg_batch_rows
       GROUP BY customer_id, product_id
       HAVING COUNT(*) <> 50
          OR COUNT(*) FILTER (WHERE verification_type = 'NORMAL') <> 45
          OR COUNT(*) FILTER (WHERE verification_type = 'EXPERIENCE') <> 5
     ) THEN
    RAISE EXCEPTION 'batch row generation failed';
  END IF;
END;
$batch_row_preflight$;

ALTER TABLE public.verification_records
  DISABLE TRIGGER trg_verification_refresh_customer_balance;
ALTER TABLE public.verification_records
  DISABLE TRIGGER trg_verification_status_history;

INSERT INTO public.verification_records
  (verification_code, verification_type, store_id, teacher_id, customer_id,
   product_id, unit_count, record_status, submitted_by_account_id,
   reviewed_by_account_id, submitted_at, reviewed_at, message)
SELECT
  FORMAT('%sV%s', row.run_tag, LPAD(row.global_seq::TEXT, 7, '0')),
  row.verification_type,
  row.store_id,
  row.teacher_id,
  row.customer_id,
  row.product_id,
  1,
  'APPROVED',
  row.store_account_id,
  row.reviewer_account_id,
  row.run_anchor - ((row.use_no - 1) * INTERVAL '1 day'),
  row.run_anchor - ((row.use_no - 1) * INTERVAL '1 day') + INTERVAL '1 minute',
  FORMAT('large-scale-no-photo %s', row.run_tag)
FROM _lsg_batch_rows AS row
ON CONFLICT (verification_code) DO NOTHING;

ALTER TABLE public.verification_records
  ENABLE TRIGGER trg_verification_refresh_customer_balance;
ALTER TABLE public.verification_records
  ENABLE TRIGGER trg_verification_status_history;

DO $batch_assert$
DECLARE
  expected_count BIGINT;
  actual_count BIGINT;
  mismatch_count BIGINT;
  trigger_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO expected_count FROM _lsg_batch_rows;
  SELECT COUNT(*) INTO actual_count
  FROM public.verification_records AS record
  JOIN _lsg_batch_rows AS row
    ON record.verification_code = FORMAT(
      '%sV%s', row.run_tag, LPAD(row.global_seq::TEXT, 7, '0')
    );
  SELECT COUNT(*) INTO mismatch_count
  FROM public.verification_records AS record
  JOIN _lsg_batch_rows AS row
    ON record.verification_code = FORMAT(
      '%sV%s', row.run_tag, LPAD(row.global_seq::TEXT, 7, '0')
    )
  WHERE record.verification_type IS DISTINCT FROM row.verification_type
     OR record.store_id IS DISTINCT FROM row.store_id
     OR record.teacher_id IS DISTINCT FROM row.teacher_id
     OR record.customer_id IS DISTINCT FROM row.customer_id
     OR record.product_id IS DISTINCT FROM row.product_id
     OR record.unit_count <> 1
     OR record.record_status <> 'APPROVED'
     OR record.face_request_id IS NOT NULL;
  SELECT COUNT(*) INTO trigger_count
  FROM pg_catalog.pg_trigger AS t
  WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
    AND t.tgrelid = 'public.verification_records'::REGCLASS
    AND t.tgname IN (
      'trg_verification_refresh_customer_balance',
      'trg_verification_status_history'
    );
  IF actual_count <> expected_count OR mismatch_count <> 0 OR trigger_count <> 2 THEN
    RAISE EXCEPTION
      'batch assertion failed (expected %, actual %, mismatches %, enabled triggers %)',
      expected_count, actual_count, mismatch_count, trigger_count;
  END IF;
END;
$batch_assert$;

INSERT INTO public.lsg_stress_run_batches
  (run_tag, batch_no, expected_rows, actual_rows, committed_at)
SELECT
  batch.run_tag,
  batch.batch_no,
  15000,
  COUNT(record.id)::INTEGER,
  CLOCK_TIMESTAMP()
FROM _lsg_batch_params AS batch
JOIN _lsg_batch_rows AS row ON TRUE
JOIN public.verification_records AS record
  ON record.verification_code = FORMAT(
    '%sV%s', row.run_tag, LPAD(row.global_seq::TEXT, 7, '0')
  )
GROUP BY batch.run_tag, batch.batch_no
ON CONFLICT (run_tag, batch_no) DO UPDATE
SET expected_rows = EXCLUDED.expected_rows,
    actual_rows = EXCLUDED.actual_rows,
    committed_at = EXCLUDED.committed_at;

UPDATE public.lsg_stress_runs
SET status = 'LOADING', updated_at = CLOCK_TIMESTAMP()
WHERE run_tag = 'LSG20260820A';

SELECT batch_no, expected_rows, actual_rows, committed_at
FROM public.lsg_stress_run_batches
WHERE run_tag = 'LSG20260820A'
  AND batch_no = (SELECT batch_no FROM _lsg_batch_params);
COMMIT;

-- Read-only progress check.  Run separately whenever the editor session is
-- interrupted; it returns the exact batch numbers still to execute.
SELECT
  COUNT(committed.batch_no)::INTEGER AS committed_batches,
  COALESCE(SUM(committed.actual_rows), 0)::BIGINT AS committed_verifications,
  ARRAY_AGG(expected.batch_no ORDER BY expected.batch_no)
    FILTER (WHERE committed.batch_no IS NULL) AS remaining_batches
FROM GENERATE_SERIES(1, 100) AS expected(batch_no)
LEFT JOIN public.lsg_stress_run_batches AS committed
  ON committed.run_tag = 'LSG20260820A'
 AND committed.batch_no = expected.batch_no;

-- ===========================================================================
-- PHASE 3 -- Run once after all 100 verification batches have committed.
-- Rebuild only the derived balance/customer rows, then validate the full load.
-- ===========================================================================
BEGIN;
SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '35s';
SET LOCAL lock_timeout = '5s';

DO $phase3_preflight$
DECLARE
  batch_count BIGINT;
  recorded_rows BIGINT;
  verification_count BIGINT;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(actual_rows), 0)
    INTO batch_count, recorded_rows
  FROM public.lsg_stress_run_batches
  WHERE run_tag = 'LSG20260820A';
  SELECT COUNT(*) INTO verification_count
  FROM public.verification_records
  WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV';
  IF batch_count <> 100 OR recorded_rows <> 1500000 OR verification_count <> 1500000 THEN
    RAISE EXCEPTION
      'phase 3 requires 100 complete batches / 1,500,000 rows (batches %, registry rows %, facts %)',
      batch_count, recorded_rows, verification_count;
  END IF;
END;
$phase3_preflight$;

WITH customer_map AS (
  SELECT
    c.id AS customer_id,
    RIGHT(c.customer_code, 3)::INTEGER AS customer_seq
  FROM public.lsg_stress_runs AS run
  JOIN public.customers AS c
    ON LEFT(c.customer_code, LENGTH(run.run_tag) + 1) = run.run_tag || 'C'
  WHERE run.run_tag = 'LSG20260820A'
)
INSERT INTO public.customer_product_balances
  (customer_id, product_id, total_recharge_count, total_verification_count,
   remaining_count, updated_at)
SELECT
  customer.customer_id,
  product.product_id,
  CASE WHEN MOD(customer.customer_seq, 10) = 0 THEN 40 ELSE 50 END,
  45,
  CASE WHEN MOD(customer.customer_seq, 10) = 0 THEN 0 ELSE 5 END,
  CLOCK_TIMESTAMP()
FROM customer_map AS customer
JOIN public.lsg_stress_run_products AS product
  ON product.run_tag = 'LSG20260820A'
ON CONFLICT (customer_id, product_id) DO UPDATE
SET total_recharge_count = EXCLUDED.total_recharge_count,
    total_verification_count = EXCLUDED.total_verification_count,
    remaining_count = EXCLUDED.remaining_count,
    updated_at = EXCLUDED.updated_at;

UPDATE public.customers AS customer
SET
  total_recharge_count = CASE
    WHEN MOD(RIGHT(customer.customer_code, 3)::INTEGER, 10) = 0 THEN 120
    ELSE 150
  END,
  total_verification_count = 150,
  total_experience_count = 15,
  latest_recharge_at = run.run_anchor - INTERVAL '60 days',
  latest_verification_at = run.run_anchor,
  customer_process_status = 'RECHARGED_WITH_CONSUMPTION',
  updated_at = CLOCK_TIMESTAMP()
FROM public.lsg_stress_runs AS run
WHERE run.run_tag = 'LSG20260820A'
  AND LEFT(customer.customer_code, LENGTH(run.run_tag) + 1) = run.run_tag || 'C';

DO $phase3_assert$
DECLARE
  total_verifications BIGINT;
  normal_verifications BIGINT;
  experience_verifications BIGINT;
  new_recharges BIGINT;
  refund_recharges BIGINT;
  recharge_units BIGINT;
  refund_units BIGINT;
  balance_count BIGINT;
  bad_customer_count BIGINT;
  bad_balance_count BIGINT;
  photo_count BIGINT;
  history_count BIGINT;
  last_seven_count BIGINT;
  last_thirty_count BIGINT;
  product_fingerprint TEXT;
  expected_fingerprint TEXT;
BEGIN
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE verification_type = 'NORMAL'),
    COUNT(*) FILTER (WHERE verification_type = 'EXPERIENCE')
  INTO total_verifications, normal_verifications, experience_verifications
  FROM public.verification_records
  WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
    AND record_status = 'APPROVED';

  SELECT
    COUNT(*) FILTER (WHERE recharge_type = 'NEW'),
    COUNT(*) FILTER (WHERE recharge_type = 'REFUND'),
    COALESCE(SUM(unit_count) FILTER (WHERE recharge_type = 'NEW'), 0),
    COALESCE(SUM(unit_count) FILTER (WHERE recharge_type = 'REFUND'), 0)
  INTO new_recharges, refund_recharges, recharge_units, refund_units
  FROM public.recharge_records
  WHERE LEFT(recharge_code, LENGTH('LSG20260820A') + 1)
      IN ('LSG20260820AR', 'LSG20260820AF')
    AND record_status = 'APPROVED';

  SELECT COUNT(*) INTO balance_count
  FROM public.customer_product_balances AS balance
  JOIN public.customers AS customer ON customer.id = balance.customer_id
  WHERE LEFT(customer.customer_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AC';

  SELECT COUNT(*) INTO bad_customer_count
  FROM public.customers AS customer
  JOIN public.lsg_stress_runs AS run ON run.run_tag = 'LSG20260820A'
  WHERE LEFT(customer.customer_code, LENGTH(run.run_tag) + 1) = run.run_tag || 'C'
    AND (
      customer.customer_status <> 'ACTIVE'
      OR customer.customer_process_status <> 'RECHARGED_WITH_CONSUMPTION'
      OR customer.total_recharge_count <> CASE
        WHEN MOD(RIGHT(customer.customer_code, 3)::INTEGER, 10) = 0 THEN 120
        ELSE 150
      END
      OR customer.total_verification_count <> 150
      OR customer.total_experience_count <> 15
      OR customer.latest_recharge_at IS DISTINCT FROM run.run_anchor - INTERVAL '60 days'
      OR customer.latest_verification_at IS DISTINCT FROM run.run_anchor
      OR customer.profile_photo_file_id IS NOT NULL
    );

  SELECT COUNT(*) INTO bad_balance_count
  FROM public.customer_product_balances AS balance
  JOIN public.customers AS customer ON customer.id = balance.customer_id
  JOIN public.lsg_stress_runs AS run ON run.run_tag = 'LSG20260820A'
  WHERE LEFT(customer.customer_code, LENGTH(run.run_tag) + 1) = run.run_tag || 'C'
    AND (
      balance.total_recharge_count <> CASE
        WHEN MOD(RIGHT(customer.customer_code, 3)::INTEGER, 10) = 0 THEN 40
        ELSE 50
      END
      OR balance.total_verification_count <> 45
      OR balance.remaining_count <> CASE
        WHEN MOD(RIGHT(customer.customer_code, 3)::INTEGER, 10) = 0 THEN 0
        ELSE 5
      END
    );

  SELECT COUNT(*) INTO photo_count
  FROM public.verification_photos AS photo
  JOIN public.verification_records AS record ON record.id = photo.verification_id
  WHERE LEFT(record.verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV';

  SELECT COUNT(*) INTO history_count
  FROM public.record_status_history AS history
  JOIN public.verification_records AS record ON record.id = history.record_id
  WHERE history.record_type = 'VERIFICATION'
    AND LEFT(record.verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV';

  SELECT COUNT(*) INTO last_seven_count
  FROM public.verification_records AS record
  JOIN public.lsg_stress_runs AS run ON run.run_tag = 'LSG20260820A'
  WHERE LEFT(record.verification_code, LENGTH(run.run_tag) + 1) = run.run_tag || 'V'
    AND record.record_status = 'APPROVED'
    AND record.submitted_at >= run.run_anchor - INTERVAL '6 days'
    AND record.submitted_at < run.run_anchor + INTERVAL '1 day';

  SELECT COUNT(*) INTO last_thirty_count
  FROM public.verification_records AS record
  JOIN public.lsg_stress_runs AS run ON run.run_tag = 'LSG20260820A'
  WHERE LEFT(record.verification_code, LENGTH(run.run_tag) + 1) = run.run_tag || 'V'
    AND record.record_status = 'APPROVED'
    AND record.submitted_at >= run.run_anchor - INTERVAL '29 days'
    AND record.submitted_at < run.run_anchor + INTERVAL '1 day';

  SELECT MD5(COALESCE(STRING_AGG(TO_JSONB(product)::TEXT, '|' ORDER BY product.id), ''))
    INTO product_fingerprint
  FROM public.products AS product;
  SELECT product_inventory_fingerprint INTO expected_fingerprint
  FROM public.lsg_stress_runs
  WHERE run_tag = 'LSG20260820A';

  IF total_verifications <> 1500000
     OR normal_verifications <> 1350000
     OR experience_verifications <> 150000
     OR new_recharges <> 30000
     OR refund_recharges <> 3000
     OR recharge_units <> 1500000
     OR refund_units <> 30000
     OR balance_count <> 30000
     OR bad_customer_count <> 0
     OR bad_balance_count <> 0
     OR photo_count <> 0
     OR history_count <> 0
     OR last_seven_count <> 210000
     OR last_thirty_count <> 900000
     OR product_fingerprint IS DISTINCT FROM expected_fingerprint THEN
    RAISE EXCEPTION
      'phase 3 assertion failed (all %, normal %, experience %, new %, refunds %, new units %, refund units %, balances %, bad customers %, bad balances %, photos %, history %, 7d %, 30d %, products unchanged %)',
      total_verifications, normal_verifications, experience_verifications,
      new_recharges, refund_recharges, recharge_units, refund_units,
      balance_count, bad_customer_count, bad_balance_count, photo_count,
      history_count, last_seven_count, last_thirty_count,
      product_fingerprint = expected_fingerprint;
  END IF;
END;
$phase3_assert$;

UPDATE public.lsg_stress_runs
SET status = 'COMPLETE', updated_at = CLOCK_TIMESTAMP()
WHERE run_tag = 'LSG20260820A';
COMMIT;

-- ===========================================================================
-- PHASE 4 -- Optional but recommended: run after phase 3 as a separate
-- editor execution.  It refreshes planner statistics and returns a compact
-- test receipt without mutating any business data.
-- ===========================================================================
ANALYZE public.recharge_records;
ANALYZE public.verification_records;
ANALYZE public.customer_product_balances;

WITH receipt AS (
  SELECT
    (SELECT COUNT(*)
     FROM public.stores AS store
     JOIN public.staff_accounts AS account ON account.id = store.store_account_id
     WHERE LEFT(account.staff_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AS') AS stores,
    (SELECT COUNT(*)
     FROM public.teachers AS teacher
     JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
     WHERE LEFT(account.staff_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AT') AS teachers,
    (SELECT COUNT(*) FROM public.customers
     WHERE LEFT(customer_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AC') AS customers,
    (SELECT COUNT(*) FROM public.recharge_records
     WHERE LEFT(recharge_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AR') AS recharge_documents,
    (SELECT COUNT(*) FROM public.recharge_records
     WHERE LEFT(recharge_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AF') AS refund_documents,
    (SELECT COUNT(*) FROM public.verification_records
     WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV') AS verification_documents,
    (SELECT COUNT(*) FROM public.verification_records
     WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
       AND verification_type = 'NORMAL') AS normal_verifications,
    (SELECT COUNT(*) FROM public.verification_records
     WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
       AND verification_type = 'EXPERIENCE') AS experience_verifications,
    (SELECT COUNT(*)
     FROM public.verification_photos AS photo
     JOIN public.verification_records AS record ON record.id = photo.verification_id
     WHERE LEFT(record.verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV') AS photo_rows
)
SELECT
  *,
  stores = 100
    AND teachers = 100
    AND customers = 10000
    AND recharge_documents = 30000
    AND refund_documents = 3000
    AND verification_documents = 1500000
    AND normal_verifications = 1350000
    AND experience_verifications = 150000
    AND photo_rows = 0 AS basic_pass
FROM receipt;

-- ===========================================================================
-- PHASE 5 -- Detailed, read-only aggregation audit.  Run after phase 3 when
-- validating the dashboards' store/product, customer/product, daily and
-- teacher dimensions.  Prefix filtering for refund documents is intentional:
-- their deterministic codes are sparse, so a numeric code range would omit
-- valid documents.
-- ===========================================================================
BEGIN;
SET LOCAL statement_timeout = '35s';
SET LOCAL lock_timeout = '5s';

WITH
run AS (
  SELECT run_tag, run_anchor, status
  FROM public.lsg_stress_runs
  WHERE run_tag = 'LSG20260820A'
),
test_verifications AS MATERIALIZED (
  SELECT
    record.store_id, record.teacher_id, record.customer_id, record.product_id,
    record.verification_type, record.submitted_at
  FROM public.verification_records AS record
  WHERE record.verification_code BETWEEN
      'LSG20260820AV0000001' AND 'LSG20260820AV1500000'
    AND record.record_status = 'APPROVED'
),
test_recharges AS MATERIALIZED (
  SELECT store_id, product_id, recharge_type, unit_count
  FROM public.recharge_records
  WHERE LEFT(recharge_code, LENGTH('LSG20260820A') + 1)
      IN ('LSG20260820AR', 'LSG20260820AF')
    AND record_status = 'APPROVED'
),
pair_stats AS (
  SELECT
    customer_id, product_id,
    COUNT(*) AS rows_per_pair,
    COUNT(*) FILTER (WHERE verification_type = 'NORMAL') AS normal_rows,
    COUNT(*) FILTER (WHERE verification_type = 'EXPERIENCE') AS experience_rows,
    COUNT(DISTINCT submitted_at::DATE) AS distinct_days
  FROM test_verifications
  GROUP BY customer_id, product_id
),
store_product_verification AS (
  SELECT
    store_id, product_id,
    COUNT(*) AS verification_rows,
    COUNT(*) FILTER (WHERE verification_type = 'NORMAL') AS normal_rows,
    COUNT(*) FILTER (WHERE verification_type = 'EXPERIENCE') AS experience_rows
  FROM test_verifications
  GROUP BY store_id, product_id
),
store_product_recharge AS (
  SELECT
    store_id, product_id,
    COUNT(*) FILTER (WHERE recharge_type = 'NEW') AS new_documents,
    COUNT(*) FILTER (WHERE recharge_type = 'REFUND') AS refund_documents,
    COALESCE(SUM(unit_count) FILTER (WHERE recharge_type = 'NEW'), 0) AS new_units,
    COALESCE(SUM(unit_count) FILTER (WHERE recharge_type = 'REFUND'), 0) AS refund_units
  FROM test_recharges
  GROUP BY store_id, product_id
),
daily_stats AS (
  SELECT submitted_at::DATE AS day, COUNT(*) AS verification_rows
  FROM test_verifications
  GROUP BY submitted_at::DATE
),
teacher_stats AS (
  SELECT teacher_id, COUNT(*) AS verification_rows
  FROM test_verifications
  GROUP BY teacher_id
),
lineage AS (
  SELECT COUNT(*) AS bad_rows
  FROM test_verifications AS record
  LEFT JOIN public.customers AS customer ON customer.id = record.customer_id
  LEFT JOIN public.lsg_stress_run_products AS product
    ON product.run_tag = 'LSG20260820A'
   AND product.product_id = record.product_id
  LEFT JOIN public.teachers AS teacher ON teacher.id = record.teacher_id
  LEFT JOIN public.staff_accounts AS teacher_account
    ON teacher_account.id = teacher.staff_account_id
  WHERE customer.id IS NULL
     OR LEFT(customer.customer_code, LENGTH('LSG20260820A') + 1) <> 'LSG20260820AC'
     OR customer.created_store_id IS DISTINCT FROM record.store_id
     OR product.product_id IS NULL
     OR teacher_account.id IS NULL
     OR LEFT(teacher_account.staff_code, LENGTH('LSG20260820A') + 1) <> 'LSG20260820AT'
),
balance_audit AS (
  SELECT
    COUNT(*) AS balance_rows,
    COUNT(*) FILTER (
      WHERE balance.total_recharge_count <> CASE
          WHEN MOD(RIGHT(customer.customer_code, 3)::INTEGER, 10) = 0 THEN 40
          ELSE 50
        END
         OR balance.total_verification_count <> 45
         OR balance.remaining_count <> CASE
          WHEN MOD(RIGHT(customer.customer_code, 3)::INTEGER, 10) = 0 THEN 0
          ELSE 5
        END
    ) AS bad_balances
  FROM public.customer_product_balances AS balance
  JOIN public.customers AS customer ON customer.id = balance.customer_id
  WHERE LEFT(customer.customer_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AC'
)
SELECT
  (SELECT status FROM run) AS run_status,
  (SELECT COUNT(*) FROM pair_stats) AS customer_product_pairs,
  (SELECT COUNT(*) FROM pair_stats
    WHERE rows_per_pair = 50 AND normal_rows = 45
      AND experience_rows = 5 AND distinct_days = 50) AS correct_pairs,
  (SELECT COUNT(*) FROM store_product_verification) AS store_product_groups,
  (SELECT COUNT(*) FROM store_product_verification
    WHERE verification_rows = 5000 AND normal_rows = 4500
      AND experience_rows = 500) AS correct_verification_groups,
  (SELECT COUNT(*) FROM store_product_recharge) AS recharge_groups,
  (SELECT COUNT(*) FROM store_product_recharge
    WHERE new_documents = 100 AND refund_documents = 10
      AND new_units = 5000 AND refund_units = 100) AS correct_recharge_groups,
  (SELECT COUNT(*) FROM daily_stats) AS daily_buckets,
  (SELECT COUNT(*) FROM daily_stats WHERE verification_rows = 30000) AS correct_daily_buckets,
  (SELECT MIN(day) FROM daily_stats) AS first_day,
  (SELECT MAX(day) FROM daily_stats) AS last_day,
  (SELECT COUNT(*) FROM teacher_stats) AS active_teachers,
  (SELECT COALESCE(MIN(verification_rows), 0) FROM teacher_stats) AS min_teacher_rows,
  (SELECT bad_rows FROM lineage) AS bad_lineage_rows,
  (SELECT balance_rows FROM balance_audit) AS balance_rows,
  (SELECT bad_balances FROM balance_audit) AS bad_balance_rows,
  (
    (SELECT status FROM run) = 'COMPLETE'
    AND (SELECT COUNT(*) FROM pair_stats) = 30000
    AND (SELECT COUNT(*) FROM pair_stats
      WHERE rows_per_pair = 50 AND normal_rows = 45
        AND experience_rows = 5 AND distinct_days = 50) = 30000
    AND (SELECT COUNT(*) FROM store_product_verification) = 300
    AND (SELECT COUNT(*) FROM store_product_verification
      WHERE verification_rows = 5000 AND normal_rows = 4500
        AND experience_rows = 500) = 300
    AND (SELECT COUNT(*) FROM store_product_recharge) = 300
    AND (SELECT COUNT(*) FROM store_product_recharge
      WHERE new_documents = 100 AND refund_documents = 10
        AND new_units = 5000 AND refund_units = 100) = 300
    AND (SELECT COUNT(*) FROM daily_stats) = 50
    AND (SELECT COUNT(*) FROM daily_stats WHERE verification_rows = 30000) = 50
    AND (SELECT MIN(day) FROM daily_stats)
        = ((SELECT run_anchor FROM run) - INTERVAL '49 days')::DATE
    AND (SELECT MAX(day) FROM daily_stats) = (SELECT run_anchor FROM run)::DATE
    AND (SELECT COUNT(*) FROM teacher_stats) = 100
    AND (SELECT bad_rows FROM lineage) = 0
    AND (SELECT balance_rows FROM balance_audit) = 30000
    AND (SELECT bad_balances FROM balance_audit) = 0
  ) AS detailed_pass;
COMMIT;

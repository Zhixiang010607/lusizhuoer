-- Recovery-only manifest seed for the partially completed LSG20260820A run.
--
-- Use this instead of Phase 0 in large-scale-statistics-stress-resume.sql
-- only when batches 1 through 11 (165,000 verification rows) were already
-- committed before the durable manifest/ledger tables existed.  It makes no
-- change to any business fact row.  It derives the fixed anchor, reviewer and
-- product map from those facts, refuses any unexpected shape, and then marks
-- batches 1..11 as committed.  Continue with Phase 2 at batch_no = 12.

BEGIN;
SET LOCAL TIME ZONE 'Asia/Shanghai';
SET LOCAL statement_timeout = '25s';
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

DO $seed_preflight$
DECLARE
  fact_count BIGINT;
  product_count BIGINT;
  reviewer_count BIGINT;
  first_code TEXT;
  last_code TEXT;
  first_at TIMESTAMPTZ;
  last_at TIMESTAMPTZ;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.lsg_stress_runs WHERE run_tag = 'LSG20260820A'
  ) THEN
    RAISE EXCEPTION 'seed aborted: LSG20260820A manifest already exists';
  END IF;

  SELECT
    COUNT(*),
    COUNT(DISTINCT product_id),
    COUNT(DISTINCT reviewed_by_account_id),
    MIN(verification_code),
    MAX(verification_code),
    MIN(submitted_at),
    MAX(submitted_at)
  INTO
    fact_count, product_count, reviewer_count, first_code, last_code,
    first_at, last_at
  FROM public.verification_records
  WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV';

  IF fact_count <> 165000
     OR product_count <> 3
     OR reviewer_count <> 1
     OR first_code <> 'LSG20260820AV0000001'
     OR last_code <> 'LSG20260820AV000165000'
     OR first_at IS NULL
     OR last_at IS NULL
     OR last_at - first_at <> INTERVAL '49 days' THEN
    RAISE EXCEPTION
      'seed aborted: expected 165,000 rows / 3 products / 1 reviewer / codes 1..165000 / 50 days (rows %, products %, reviewers %, first %, last %, span %)',
      fact_count, product_count, reviewer_count, first_code, last_code,
      last_at - first_at;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.verification_records AS record
    JOIN public.staff_accounts AS reviewer ON reviewer.id = record.reviewed_by_account_id
    WHERE LEFT(record.verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
      AND reviewer.role_code = 'hq'
      AND reviewer.account_status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'seed aborted: the persisted reviewer is not an active HQ account';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.verification_records AS record
    WHERE LEFT(record.verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
      AND (
        record.record_status <> 'APPROVED'
        OR record.verification_type NOT IN ('NORMAL', 'EXPERIENCE')
        OR record.unit_count <> 1
        OR record.face_request_id IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.verification_records AS record
    WHERE LEFT(record.verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
    GROUP BY record.customer_id, record.product_id
    HAVING COUNT(*) <> 50
       OR COUNT(*) FILTER (WHERE record.verification_type = 'NORMAL') <> 45
       OR COUNT(*) FILTER (WHERE record.verification_type = 'EXPERIENCE') <> 5
  ) THEN
    RAISE EXCEPTION 'seed aborted: the existing fact rows do not match the 45 NORMAL + 5 EXPERIENCE batch shape';
  END IF;

  -- Batches 1..11 were originally assigned global codes by customer.id order,
  -- not by the printable customer code.  Prove that mapping before allowing
  -- the resumed runner to begin at V000165001.
  IF EXISTS (
    WITH ordered_customers AS (
      SELECT
        customer.id AS customer_id,
        ROW_NUMBER() OVER (ORDER BY customer.id)::INTEGER AS customer_ordinal
      FROM public.customers AS customer
      WHERE LEFT(customer.customer_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AC'
    ), selected_product_ids AS (
      SELECT DISTINCT product_id
      FROM public.verification_records
      WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
    ), selected_products AS (
      SELECT product_id,
        ROW_NUMBER() OVER (ORDER BY product_id)::INTEGER AS product_idx
      FROM selected_product_ids
    ), expected AS (
      SELECT
        ((customer.customer_ordinal - 1) * 3 * 50
          + (product.product_idx - 1) * 50 + use_row.use_no)::INTEGER AS global_seq,
        customer.customer_id,
        product.product_id
      FROM ordered_customers AS customer
      JOIN selected_products AS product ON TRUE
      CROSS JOIN LATERAL GENERATE_SERIES(1, 50) AS use_row(use_no)
      WHERE customer.customer_ordinal <= 1100
    )
    SELECT 1
    FROM expected
    LEFT JOIN public.verification_records AS record
      ON record.verification_code = FORMAT(
        'LSG20260820AV%s', LPAD(expected.global_seq::TEXT, 7, '0')
      )
    WHERE record.id IS NULL
       OR record.customer_id IS DISTINCT FROM expected.customer_id
       OR record.product_id IS DISTINCT FROM expected.product_id
  ) THEN
    RAISE EXCEPTION 'seed aborted: existing V0000001..V000165000 rows do not use customer.id sequence order';
  END IF;
END;
$seed_preflight$;

INSERT INTO public.lsg_stress_runs
  (run_tag, run_anchor, reviewer_account_id, product_inventory_count,
   product_inventory_fingerprint, status)
SELECT
  'LSG20260820A',
  MAX(record.submitted_at),
  MIN(record.reviewed_by_account_id),
  inventory.row_count,
  inventory.fingerprint,
  'LOADING'
FROM public.verification_records AS record
CROSS JOIN LATERAL (
  SELECT
    COUNT(*)::BIGINT AS row_count,
    MD5(COALESCE(STRING_AGG(TO_JSONB(product)::TEXT, '|' ORDER BY product.id), '')) AS fingerprint
  FROM public.products AS product
) AS inventory
WHERE LEFT(record.verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
GROUP BY inventory.row_count, inventory.fingerprint;

INSERT INTO public.lsg_stress_run_products (run_tag, product_idx, product_id)
SELECT
  'LSG20260820A',
  ROW_NUMBER() OVER (ORDER BY persisted.product_id)::SMALLINT,
  persisted.product_id
FROM (
  SELECT DISTINCT product_id
  FROM public.verification_records
  WHERE LEFT(verification_code, LENGTH('LSG20260820A') + 1) = 'LSG20260820AV'
) AS persisted;

INSERT INTO public.lsg_stress_run_batches
  (run_tag, batch_no, expected_rows, actual_rows, committed_at)
SELECT
  'LSG20260820A',
  batch.batch_no,
  15000,
  COUNT(record.id)::INTEGER,
  CLOCK_TIMESTAMP()
FROM GENERATE_SERIES(1, 11) AS batch(batch_no)
LEFT JOIN public.verification_records AS record
  ON record.verification_code BETWEEN
       FORMAT('LSG20260820AV%s', LPAD(((batch.batch_no - 1) * 15000 + 1)::TEXT, 7, '0'))
       AND FORMAT('LSG20260820AV%s', LPAD((batch.batch_no * 15000)::TEXT, 7, '0'))
GROUP BY batch.batch_no;

DO $seed_assert$
DECLARE
  batch_count BIGINT;
  bad_batch_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO batch_count
  FROM public.lsg_stress_run_batches
  WHERE run_tag = 'LSG20260820A';
  SELECT COUNT(*) INTO bad_batch_count
  FROM public.lsg_stress_run_batches
  WHERE run_tag = 'LSG20260820A'
    AND (expected_rows <> 15000 OR actual_rows <> 15000);
  IF batch_count <> 11 OR bad_batch_count <> 0 THEN
    RAISE EXCEPTION 'seed assertion failed (batches %, bad batches %)', batch_count, bad_batch_count;
  END IF;
END;
$seed_assert$;

SELECT run_tag, run_anchor, reviewer_account_id, status,
       (SELECT COUNT(*) FROM public.lsg_stress_run_batches AS batch
        WHERE batch.run_tag = run.run_tag) AS seeded_batches
FROM public.lsg_stress_runs AS run
WHERE run_tag = 'LSG20260820A';
COMMIT;

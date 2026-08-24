-- ============================================================================
-- DESTRUCTIVE: clear application data before the large-scale statistics test.
-- ============================================================================
-- Run only in the intended CloudBase PostgreSQL test environment and only after
-- a verified backup. This script permanently removes all rows from the known
-- operational tables listed below and removes every non-HQ login account.
--
-- Preserved deliberately:
--   * every public.products row and every product field, including the logo
--     reference and receipt_template_updated_by. If a non-NULL updater does not
--     point to an HQ account, the script aborts before deleting anything;
--   * staff_accounts rows whose role_code is exactly 'hq', together with their
--     HQ profile, HQ role assignment and HQ identity link;
--   * access_roles and role_permissions, because they are the static permission
--     catalogue required both by retained HQ accounts and by the subsequent
--     large-scale test when it creates store and teacher accounts;
--   * every table, row and object in the storage schema. This script never
--     targets storage and intentionally does not delete private stored files.
--
-- Safety properties:
--   * pure PostgreSQL SQL; no psql backslash commands;
--   * one explicit transaction, with every failed assertion raising an
--     exception and therefore aborting/rolling back the whole transaction;
--   * ACCESS EXCLUSIVE locks prevent concurrent application writes from racing
--     the snapshots and postconditions;
--   * only the repository-known public tables named in _lsg_clear_counts are
--     considered; a missing optional table is reported as SKIPPED;
--   * no TRUNCATE CASCADE is used. An unknown referencing table makes the script
--     fail safely instead of being cleared implicitly;
--   * customer_messages is cleared by TRUNCATE, so its append-only DELETE
--     trigger is never bypassed or disabled.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '10min';

DROP TABLE IF EXISTS pg_temp._lsg_clear_counts;
DROP TABLE IF EXISTS pg_temp._lsg_clear_adjustments;
DROP TABLE IF EXISTS pg_temp._lsg_hq_before;
DROP TABLE IF EXISTS pg_temp._lsg_products_before;

CREATE TEMP TABLE _lsg_clear_counts (
  table_name TEXT PRIMARY KEY,
  cleanup_policy TEXT NOT NULL,
  existed_before BOOLEAN NOT NULL DEFAULT FALSE,
  before_count BIGINT,
  after_count BIGINT
) ON COMMIT PRESERVE ROWS;

-- This is the complete, explicit union of application tables created by the
-- repository's schema files and migrations 002 through 045, plus the durable
-- LSG run bookkeeping tables created by the timeout-resistant stress runner.
-- Do not replace it with a pg_catalog scan: unknown tables must never be
-- deleted implicitly.
INSERT INTO _lsg_clear_counts (table_name, cleanup_policy)
VALUES
  ('access_roles', 'PRESERVE_STATIC'),
  ('account_identity_links', 'PRESERVE_HQ'),
  ('account_role_assignments', 'PRESERVE_HQ'),
  ('audit_logs', 'TRUNCATE'),
  ('business_events', 'TRUNCATE'),
  ('credential_events', 'TRUNCATE'),
  ('customer_messages', 'TRUNCATE'),
  ('customer_product_balances', 'TRUNCATE'),
  ('customers', 'TRUNCATE'),
  ('device_signal_outbox', 'TRUNCATE'),
  ('hq_profiles', 'PRESERVE_HQ'),
  ('lsg_stress_run_batches', 'TRUNCATE'),
  ('lsg_stress_run_products', 'TRUNCATE'),
  ('lsg_stress_runs', 'TRUNCATE'),
  ('operation_profiles', 'TRUNCATE'),
  ('operation_store_scopes', 'TRUNCATE'),
  ('products', 'PRESERVE_PRODUCTS'),
  ('recharge_records', 'TRUNCATE'),
  ('recharge_void_requests', 'TRUNCATE'),
  ('record_status_history', 'TRUNCATE'),
  ('role_permissions', 'PRESERVE_STATIC'),
  ('staff_accounts', 'PRESERVE_HQ'),
  ('staff_store_assignments', 'TRUNCATE'),
  ('store_contacts', 'TRUNCATE'),
  ('stores', 'TRUNCATE'),
  ('teachers', 'TRUNCATE'),
  ('verification_photo_drafts', 'TRUNCATE'),
  ('verification_photo_events', 'TRUNCATE'),
  ('verification_photo_upload_requests', 'TRUNCATE'),
  ('verification_photos', 'TRUNCATE'),
  ('verification_records', 'TRUNCATE'),
  ('verification_review_requests', 'TRUNCATE');

CREATE TEMP TABLE _lsg_clear_adjustments (
  metric TEXT PRIMARY KEY,
  changed_rows BIGINT NOT NULL,
  detail TEXT NOT NULL
) ON COMMIT PRESERVE ROWS;

-- Lock only known tables, in a stable order. Missing legacy/optional tables are
-- intentionally skipped. The required tables are asserted immediately after.
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT table_name
    FROM pg_temp._lsg_clear_counts
    ORDER BY table_name
  LOOP
    IF TO_REGCLASS(FORMAT('%I.%I', 'public', item.table_name)) IS NOT NULL THEN
      EXECUTE FORMAT(
        'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
        'public', item.table_name
      );
      UPDATE pg_temp._lsg_clear_counts
      SET existed_before = TRUE
      WHERE table_name = item.table_name;
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  hq_count BIGINT;
  product_count BIGINT;
  invalid_reference BOOLEAN := FALSE;
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL THEN
    RAISE EXCEPTION
      'DESTRUCTIVE CLEAR ABORTED: required table public.staff_accounts is missing';
  END IF;
  IF TO_REGCLASS('public.products') IS NULL THEN
    RAISE EXCEPTION
      'DESTRUCTIVE CLEAR ABORTED: required table public.products is missing';
  END IF;

  SELECT COUNT(*) INTO hq_count
  FROM public.staff_accounts
  WHERE role_code = 'hq';

  SELECT COUNT(*) INTO product_count
  FROM public.products;

  IF hq_count < 1 THEN
    RAISE EXCEPTION
      'DESTRUCTIVE CLEAR ABORTED: expected at least 1 HQ account, found %',
      hq_count;
  END IF;
  IF product_count < 3 THEN
    RAISE EXCEPTION
      'DESTRUCTIVE CLEAR ABORTED: expected at least 3 products, found %',
      product_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'products'
      AND column_name = 'receipt_template_updated_by'
  ) THEN
    EXECUTE $statement$
      SELECT EXISTS (
        SELECT 1
        FROM public.products product
        WHERE product.receipt_template_updated_by IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.staff_accounts account
            WHERE account.id = product.receipt_template_updated_by
              AND account.role_code = 'hq'
          )
      )
    $statement$ INTO invalid_reference;

    IF invalid_reference THEN
      RAISE EXCEPTION
        'DESTRUCTIVE CLEAR ABORTED: a product updater is not an HQ account; every product field must remain unchanged';
    END IF;
  END IF;

  -- If the identity model exists, refuse to turn an already-inconsistent HQ
  -- login into an unusable retained account.
  IF TO_REGCLASS('public.hq_profiles') IS NOT NULL THEN
    EXECUTE $statement$
      SELECT EXISTS (
        SELECT 1
        FROM public.staff_accounts account
        WHERE account.role_code = 'hq'
          AND NOT EXISTS (
            SELECT 1
            FROM public.hq_profiles profile
            WHERE profile.staff_account_id = account.id
          )
      )
    $statement$ INTO invalid_reference;
    IF invalid_reference THEN
      RAISE EXCEPTION
        'DESTRUCTIVE CLEAR ABORTED: an HQ account has no corresponding hq_profiles row';
    END IF;
  END IF;

  IF TO_REGCLASS('public.account_role_assignments') IS NOT NULL THEN
    EXECUTE $statement$
      SELECT EXISTS (
        SELECT 1
        FROM public.staff_accounts account
        WHERE account.role_code = 'hq'
          AND NOT EXISTS (
            SELECT 1
            FROM public.account_role_assignments assignment
            WHERE assignment.account_id = account.id
              AND assignment.role_code = 'hq'
          )
      )
    $statement$ INTO invalid_reference;
    IF invalid_reference THEN
      RAISE EXCEPTION
        'DESTRUCTIVE CLEAR ABORTED: an HQ account has no corresponding HQ role assignment';
    END IF;
  END IF;

  IF TO_REGCLASS('public.account_identity_links') IS NOT NULL
     AND TO_REGCLASS('public.hq_profiles') IS NOT NULL THEN
    EXECUTE $statement$
      SELECT EXISTS (
        SELECT 1
        FROM public.staff_accounts account
        JOIN public.hq_profiles profile
          ON profile.staff_account_id = account.id
        WHERE account.role_code = 'hq'
          AND NOT EXISTS (
            SELECT 1
            FROM public.account_identity_links link
            WHERE link.account_id = account.id
              AND link.subject_type = 'hq'
              AND link.subject_id = profile.id
          )
      )
    $statement$ INTO invalid_reference;
    IF invalid_reference THEN
      RAISE EXCEPTION
        'DESTRUCTIVE CLEAR ABORTED: an HQ account has no corresponding HQ identity link';
    END IF;
  END IF;
END;
$$;

-- Immutable snapshots used by the final assertions. JSONB makes the product
-- comparison automatically covers current and future business columns,
-- including receipt_template_updated_by.
CREATE TEMP TABLE _lsg_hq_before
ON COMMIT PRESERVE ROWS
AS
SELECT account.id, TO_JSONB(account) AS row_snapshot
FROM public.staff_accounts account
WHERE account.role_code = 'hq';

CREATE UNIQUE INDEX _lsg_hq_before_id
  ON _lsg_hq_before(id);

CREATE TEMP TABLE _lsg_products_before
ON COMMIT PRESERVE ROWS
AS
SELECT
  product.id,
  TO_JSONB(product) AS row_snapshot,
  TO_JSONB(product) -> 'receipt_logo_file_id' AS receipt_logo_file_id
FROM public.products product;

CREATE UNIQUE INDEX _lsg_products_before_id
  ON _lsg_products_before(id);

-- Capture before-counts only after every known existing table is locked.
DO $$
DECLARE
  item RECORD;
  row_count BIGINT;
BEGIN
  FOR item IN
    SELECT table_name
    FROM pg_temp._lsg_clear_counts
    WHERE existed_before
    ORDER BY table_name
  LOOP
    EXECUTE FORMAT(
      'SELECT COUNT(*) FROM %I.%I',
      'public', item.table_name
    ) INTO row_count;

    UPDATE pg_temp._lsg_clear_counts
    SET before_count = row_count
    WHERE table_name = item.table_name;
  END LOOP;
END;
$$;

-- Truncate all operational tables together so their known mutual foreign keys
-- are satisfied. There is deliberately no CASCADE: an unknown referencing
-- table must abort the transaction instead of being erased. TRUNCATE also
-- avoids firing customer_messages'' append-only row DELETE trigger.
DO $$
DECLARE
  targets TEXT;
BEGIN
  SELECT STRING_AGG(
           FORMAT('%I.%I', 'public', table_name),
           ', ' ORDER BY table_name
         )
  INTO targets
  FROM pg_temp._lsg_clear_counts
  WHERE cleanup_policy = 'TRUNCATE'
    AND existed_before;

  IF targets IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || targets || ' RESTART IDENTITY';
  END IF;
END;
$$;

-- Retain only the HQ-specific profile/assignment/link rows. Nullable audit FKs
-- on retained rows are cleared only when they point at a soon-to-be-deleted
-- non-HQ account.
DO $$
DECLARE
  changed_count BIGINT;
  has_hq_profiles BOOLEAN := TO_REGCLASS('public.hq_profiles') IS NOT NULL;
BEGIN
  IF TO_REGCLASS('public.account_identity_links') IS NOT NULL THEN
    IF has_hq_profiles THEN
      EXECUTE $statement$
        DELETE FROM public.account_identity_links link
        WHERE NOT EXISTS (
                SELECT 1 FROM pg_temp._lsg_hq_before hq
                WHERE hq.id = link.account_id
              )
           OR link.subject_type IS DISTINCT FROM 'hq'
           OR NOT EXISTS (
                SELECT 1
                FROM public.hq_profiles profile
                WHERE profile.staff_account_id = link.account_id
                  AND profile.id = link.subject_id
              )
      $statement$;
    ELSE
      EXECUTE $statement$
        DELETE FROM public.account_identity_links link
        WHERE NOT EXISTS (
                SELECT 1 FROM pg_temp._lsg_hq_before hq
                WHERE hq.id = link.account_id
              )
           OR link.subject_type IS DISTINCT FROM 'hq'
      $statement$;
    END IF;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    INSERT INTO pg_temp._lsg_clear_adjustments(metric, changed_rows, detail)
    VALUES (
      'account_identity_links rows removed',
      changed_count,
      'Only links for retained HQ accounts and HQ subjects remain'
    );

    EXECUTE $statement$
      UPDATE public.account_identity_links link
      SET linked_by = NULL
      WHERE link.linked_by IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pg_temp._lsg_hq_before hq
          WHERE hq.id = link.linked_by
        )
    $statement$;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    INSERT INTO pg_temp._lsg_clear_adjustments(metric, changed_rows, detail)
    VALUES (
      'account_identity_links.linked_by',
      changed_count,
      'Retained HQ links whose audit FK referenced a non-HQ account were nulled'
    );
  END IF;

  IF TO_REGCLASS('public.account_role_assignments') IS NOT NULL THEN
    EXECUTE $statement$
      DELETE FROM public.account_role_assignments assignment
      WHERE NOT EXISTS (
              SELECT 1 FROM pg_temp._lsg_hq_before hq
              WHERE hq.id = assignment.account_id
            )
         OR assignment.role_code IS DISTINCT FROM 'hq'
    $statement$;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    INSERT INTO pg_temp._lsg_clear_adjustments(metric, changed_rows, detail)
    VALUES (
      'account_role_assignments rows removed',
      changed_count,
      'Only HQ role assignments for retained HQ accounts remain'
    );

    EXECUTE $statement$
      UPDATE public.account_role_assignments assignment
      SET granted_by = NULL
      WHERE assignment.granted_by IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pg_temp._lsg_hq_before hq
          WHERE hq.id = assignment.granted_by
        )
    $statement$;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    INSERT INTO pg_temp._lsg_clear_adjustments(metric, changed_rows, detail)
    VALUES (
      'account_role_assignments.granted_by',
      changed_count,
      'Retained HQ assignments whose audit FK referenced a non-HQ account were nulled'
    );
  END IF;

  IF has_hq_profiles THEN
    EXECUTE $statement$
      DELETE FROM public.hq_profiles profile
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_temp._lsg_hq_before hq
        WHERE hq.id = profile.staff_account_id
      )
    $statement$;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    INSERT INTO pg_temp._lsg_clear_adjustments(metric, changed_rows, detail)
    VALUES (
      'hq_profiles rows removed',
      changed_count,
      'Only profiles belonging to retained HQ accounts remain'
    );
  END IF;
END;
$$;

DELETE FROM public.staff_accounts account
WHERE account.role_code <> 'hq';

INSERT INTO _lsg_clear_adjustments(metric, changed_rows, detail)
VALUES (
  'staff_accounts non-HQ rows removed',
  (SELECT before_count - COUNT(*)
   FROM _lsg_clear_counts, public.staff_accounts
   WHERE table_name = 'staff_accounts'
   GROUP BY before_count),
  'Every remaining login account must have role_code = hq'
);

-- Capture after-counts and enforce every postcondition before COMMIT.
DO $$
DECLARE
  item RECORD;
  row_count BIGINT;
  invalid_reference BOOLEAN := FALSE;
BEGIN
  FOR item IN
    SELECT table_name, cleanup_policy, existed_before
    FROM pg_temp._lsg_clear_counts
    ORDER BY table_name
  LOOP
    IF item.existed_before THEN
      EXECUTE FORMAT(
        'SELECT COUNT(*) FROM %I.%I',
        'public', item.table_name
      ) INTO row_count;

      UPDATE pg_temp._lsg_clear_counts
      SET after_count = row_count
      WHERE table_name = item.table_name;

      IF item.cleanup_policy = 'TRUNCATE' AND row_count <> 0 THEN
        RAISE EXCEPTION
          'DESTRUCTIVE CLEAR ROLLED BACK: public.% still contains % rows',
          item.table_name, row_count;
      END IF;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.staff_accounts WHERE role_code <> 'hq'
  ) THEN
    RAISE EXCEPTION
      'DESTRUCTIVE CLEAR ROLLED BACK: non-HQ staff_accounts rows remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp._lsg_hq_before before_row
    FULL JOIN public.staff_accounts after_row
      ON after_row.id = before_row.id
     AND after_row.role_code = 'hq'
    WHERE before_row.id IS NULL
       OR after_row.id IS NULL
       OR TO_JSONB(after_row) IS DISTINCT FROM before_row.row_snapshot
  ) THEN
    RAISE EXCEPTION
      'DESTRUCTIVE CLEAR ROLLED BACK: at least one HQ account changed or disappeared';
  END IF;

  IF TO_REGCLASS('public.hq_profiles') IS NOT NULL THEN
    EXECUTE $statement$
      SELECT EXISTS (
        SELECT 1
        FROM public.hq_profiles profile
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_temp._lsg_hq_before hq
          WHERE hq.id = profile.staff_account_id
        )
      )
    $statement$ INTO invalid_reference;
    IF invalid_reference THEN
      RAISE EXCEPTION
        'DESTRUCTIVE CLEAR ROLLED BACK: a non-HQ hq_profiles row remains';
    END IF;
  END IF;

  IF TO_REGCLASS('public.account_role_assignments') IS NOT NULL THEN
    EXECUTE $statement$
      SELECT EXISTS (
        SELECT 1
        FROM public.account_role_assignments assignment
        WHERE assignment.role_code IS DISTINCT FROM 'hq'
           OR NOT EXISTS (
                SELECT 1 FROM pg_temp._lsg_hq_before hq
                WHERE hq.id = assignment.account_id
              )
           OR (
                assignment.granted_by IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM pg_temp._lsg_hq_before hq
                  WHERE hq.id = assignment.granted_by
                )
              )
      )
    $statement$ INTO invalid_reference;
    IF invalid_reference THEN
      RAISE EXCEPTION
        'DESTRUCTIVE CLEAR ROLLED BACK: a non-HQ role assignment or audit FK remains';
    END IF;
  END IF;

  IF TO_REGCLASS('public.account_identity_links') IS NOT NULL THEN
    IF TO_REGCLASS('public.hq_profiles') IS NOT NULL THEN
      EXECUTE $statement$
        SELECT EXISTS (
          SELECT 1
          FROM public.account_identity_links link
          WHERE link.subject_type IS DISTINCT FROM 'hq'
             OR NOT EXISTS (
                  SELECT 1 FROM pg_temp._lsg_hq_before hq
                  WHERE hq.id = link.account_id
                )
             OR (
                  link.linked_by IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM pg_temp._lsg_hq_before hq
                    WHERE hq.id = link.linked_by
                  )
                )
             OR NOT EXISTS (
                  SELECT 1
                  FROM public.hq_profiles profile
                  WHERE profile.staff_account_id = link.account_id
                    AND profile.id = link.subject_id
                )
        )
      $statement$ INTO invalid_reference;
    ELSE
      EXECUTE $statement$
        SELECT EXISTS (
          SELECT 1
          FROM public.account_identity_links link
          WHERE link.subject_type IS DISTINCT FROM 'hq'
             OR NOT EXISTS (
                  SELECT 1 FROM pg_temp._lsg_hq_before hq
                  WHERE hq.id = link.account_id
                )
             OR (
                  link.linked_by IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM pg_temp._lsg_hq_before hq
                    WHERE hq.id = link.linked_by
                  )
                )
        )
      $statement$ INTO invalid_reference;
    END IF;
    IF invalid_reference THEN
      RAISE EXCEPTION
        'DESTRUCTIVE CLEAR ROLLED BACK: a non-HQ or mismatched identity link remains';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp._lsg_products_before before_row
    FULL JOIN public.products after_row
      ON after_row.id = before_row.id
    WHERE before_row.id IS NULL
       OR after_row.id IS NULL
       OR TO_JSONB(after_row) IS DISTINCT FROM before_row.row_snapshot
  ) THEN
    RAISE EXCEPTION
      'DESTRUCTIVE CLEAR ROLLED BACK: a product row or a protected product field changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp._lsg_products_before before_row
    JOIN public.products after_row ON after_row.id = before_row.id
    WHERE (TO_JSONB(after_row) -> 'receipt_logo_file_id')
            IS DISTINCT FROM before_row.receipt_logo_file_id
  ) THEN
    RAISE EXCEPTION
      'DESTRUCTIVE CLEAR ROLLED BACK: a product receipt_logo_file_id changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'products'
      AND column_name = 'receipt_template_updated_by'
  ) THEN
    EXECUTE $statement$
      SELECT EXISTS (
        SELECT 1
        FROM public.products product
        WHERE product.receipt_template_updated_by IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.staff_accounts account
            WHERE account.id = product.receipt_template_updated_by
              AND account.role_code = 'hq'
          )
      )
    $statement$ INTO invalid_reference;

    IF invalid_reference THEN
      RAISE EXCEPTION
        'DESTRUCTIVE CLEAR ROLLED BACK: a product updater still references a non-HQ or missing account';
    END IF;
  END IF;
END;
$$;

COMMIT;

-- CloudBase SQL editor result summary. Missing optional tables are shown as
-- SKIPPED; otherwise removed_rows is the exact before/after difference.
SELECT
  'TABLE'::TEXT AS summary_type,
  table_name AS item,
  before_count,
  after_count,
  CASE
    WHEN existed_before THEN before_count - after_count
    ELSE NULL
  END AS changed_rows,
  CASE
    WHEN NOT existed_before THEN 'SKIPPED: table did not exist'
    ELSE cleanup_policy
  END AS detail
FROM pg_temp._lsg_clear_counts

UNION ALL

SELECT
  'ADJUSTMENT'::TEXT AS summary_type,
  metric AS item,
  NULL::BIGINT AS before_count,
  NULL::BIGINT AS after_count,
  changed_rows,
  detail
FROM pg_temp._lsg_clear_adjustments

ORDER BY summary_type DESC, item;

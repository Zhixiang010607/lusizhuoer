-- Full rebuild of the business schema.
-- WARNING: this script permanently deletes the existing business tables.
-- It does not store customer phone numbers, product prices, or recharge amounts.
-- All identifiers and SQL comments are ASCII-only.
-- This is a base rebuild, not a release-complete snapshot: after it commits,
-- execute the ordered migrations through
-- 053_retire_legacy_teacher_face_saga.sql
-- before deploying current CloudBase functions. Migration 046 deliberately
-- normalizes this legacy teachers layout and installs face/quota structures;
-- migration 047 retires legacy operation identities after their audit tables exist,
-- migration 048 makes teacher face enrollment optional and adds quota lifecycle,
-- migration 049 makes new EXPERIENCE evidence belong to the selected teacher,
-- migration 050 repairs teacher/quota invariants, and migration 053 removes the
-- retired 051/052 orchestration state while preserving all teacher business data.

BEGIN;

-- Remove only the application's existing business tables. CloudBase auth tables
-- are not touched by this script.
DROP TABLE IF EXISTS public.business_events CASCADE;
DROP TABLE IF EXISTS public.credential_events CASCADE;
DROP TABLE IF EXISTS public.record_status_history CASCADE;
DROP TABLE IF EXISTS public.customer_product_balances CASCADE;
DROP TABLE IF EXISTS public.verification_records CASCADE;
DROP TABLE IF EXISTS public.recharge_records CASCADE;
DROP TABLE IF EXISTS public.operation_store_scopes CASCADE;
DROP TABLE IF EXISTS public.account_identity_links CASCADE;
DROP TABLE IF EXISTS public.account_role_assignments CASCADE;
DROP TABLE IF EXISTS public.role_permissions CASCADE;
DROP TABLE IF EXISTS public.access_roles CASCADE;
DROP TABLE IF EXISTS public.operation_profiles CASCADE;
DROP TABLE IF EXISTS public.hq_profiles CASCADE;
DROP TABLE IF EXISTS public.store_contacts CASCADE;
DROP TABLE IF EXISTS public.staff_store_assignments CASCADE;
DROP TABLE IF EXISTS public.customers CASCADE;
DROP TABLE IF EXISTS public.products CASCADE;
DROP TABLE IF EXISTS public.teachers CASCADE;
DROP TABLE IF EXISTS public.stores CASCADE;
DROP TABLE IF EXISTS public.staff_accounts CASCADE;

DROP SEQUENCE IF EXISTS public.hq_account_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.operation_account_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.teacher_account_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.store_account_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.store_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.teacher_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.product_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.customer_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.recharge_code_seq CASCADE;
DROP SEQUENCE IF EXISTS public.verification_code_seq CASCADE;

CREATE SEQUENCE public.hq_account_code_seq START WITH 1;
CREATE SEQUENCE public.operation_account_code_seq START WITH 1;
CREATE SEQUENCE public.teacher_account_code_seq START WITH 1;
CREATE SEQUENCE public.store_account_code_seq START WITH 1;
CREATE SEQUENCE public.store_code_seq START WITH 1;
CREATE SEQUENCE public.teacher_code_seq START WITH 1;
CREATE SEQUENCE public.product_code_seq START WITH 1;
CREATE SEQUENCE public.customer_code_seq START WITH 1;
CREATE SEQUENCE public.recharge_code_seq START WITH 1;
CREATE SEQUENCE public.verification_code_seq START WITH 1;

CREATE OR REPLACE FUNCTION public.next_product_code()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  code_number BIGINT;
BEGIN
  code_number := nextval('public.product_code_seq');
  RETURN 'PRD' || LPAD(
    code_number::TEXT,
    GREATEST(3, LENGTH(code_number::TEXT)),
    '0'
  );
END;
$$;

-- One table manages every login account. A phone number belongs to exactly one
-- business identity and is never copied into customer data.
CREATE TABLE public.staff_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_code VARCHAR(32) NOT NULL UNIQUE,
  auth_uid VARCHAR(64) NOT NULL UNIQUE CHECK (BTRIM(auth_uid) <> ''),
  phone CHAR(11) NOT NULL UNIQUE,
  staff_name VARCHAR(64) NOT NULL,
  role_code VARCHAR(16) NOT NULL CHECK (role_code IN ('hq', 'store', 'teacher')),
  account_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (account_status IN ('ACTIVE', 'ARCHIVED')),
  password_initialized_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  password_change_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Credential management records only password lifecycle events. Password values
-- and password hashes are intentionally never stored in the business database.
CREATE TABLE public.credential_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_staff_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  actor_staff_account_id BIGINT REFERENCES public.staff_accounts(id),
  event_type VARCHAR(32) NOT NULL
    CHECK (event_type IN ('ACCOUNT_CREATED', 'HQ_PASSWORD_RESET', 'SELF_PASSWORD_CHANGED')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credential_events_target_time
  ON public.credential_events (target_staff_account_id, occurred_at DESC);

CREATE TABLE public.stores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_code VARCHAR(32) NOT NULL UNIQUE
    DEFAULT ('STR' || LPAD(nextval('public.store_code_seq')::TEXT, 3, '0')),
  store_name VARCHAR(100) NOT NULL,
  province VARCHAR(32) NOT NULL,
  city VARCHAR(32) NOT NULL,
  district VARCHAR(32) NOT NULL,
  address_detail VARCHAR(255) NOT NULL,
  store_account_id BIGINT UNIQUE REFERENCES public.staff_accounts(id),
  store_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (store_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A store may have one or more contacts. These are store contacts, never
-- customer contact details.
CREATE TABLE public.store_contacts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  contact_name VARCHAR(64) NOT NULL,
  contact_phone CHAR(11) NOT NULL,
  contact_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (contact_status IN ('ACTIVE', 'ARCHIVED')),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, contact_name, contact_phone)
);

CREATE TABLE public.teachers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  teacher_code VARCHAR(32) NOT NULL UNIQUE
    DEFAULT ('TCH' || LPAD(nextval('public.teacher_code_seq')::TEXT, 3, '0')),
  teacher_name VARCHAR(64) NOT NULL,
  staff_account_id BIGINT NOT NULL UNIQUE REFERENCES public.staff_accounts(id),
  teacher_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (teacher_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_code VARCHAR(32) NOT NULL UNIQUE
    DEFAULT public.next_product_code(),
  product_name VARCHAR(100) NOT NULL,
  product_type VARCHAR(32) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  idempotency_key VARCHAR(64),
  product_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (product_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Customer profile. Customer phone and pricing data are intentionally absent.
CREATE TABLE public.customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_code VARCHAR(32) NOT NULL UNIQUE
    DEFAULT ('CUS' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || LPAD(nextval('public.customer_code_seq')::TEXT, 4, '0')),
  customer_name VARCHAR(64) NOT NULL,
  birth_date DATE,
  notes TEXT NOT NULL DEFAULT '',
  profile_photo_file_id VARCHAR(512),
  face_person_id VARCHAR(128) UNIQUE,
  created_store_id BIGINT NOT NULL REFERENCES public.stores(id),
  customer_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (customer_status IN ('ACTIVE', 'ARCHIVED')),
  customer_process_status VARCHAR(32) NOT NULL DEFAULT 'INFORMATION_ONLY'
    CHECK (customer_process_status IN ('INFORMATION_ONLY', 'RECHARGED_NO_CONSUMPTION', 'RECHARGED_WITH_CONSUMPTION')),
  total_recharge_count INTEGER NOT NULL DEFAULT 0 CHECK (total_recharge_count >= 0),
  total_verification_count INTEGER NOT NULL DEFAULT 0 CHECK (total_verification_count >= 0),
  total_experience_count INTEGER NOT NULL DEFAULT 0 CHECK (total_experience_count >= 0),
  latest_recharge_at TIMESTAMPTZ,
  latest_verification_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Operation accounts may access only stores assigned here.
CREATE TABLE public.operation_store_scopes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  scope_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (scope_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (operation_account_id, store_id)
);

-- Each recharge workflow row is either a purchase, historical void, or a
-- reviewed refund. Refund rows preserve before/after available-unit snapshots.
CREATE TABLE public.recharge_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recharge_code VARCHAR(32) NOT NULL UNIQUE
    DEFAULT ('RC' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || LPAD(nextval('public.recharge_code_seq')::TEXT, 4, '0')),
  recharge_type VARCHAR(16) NOT NULL DEFAULT 'NEW'
    CHECK (recharge_type IN ('NEW', 'VOID', 'REFUND')),
  original_recharge_id BIGINT REFERENCES public.recharge_records(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  teacher_id BIGINT REFERENCES public.teachers(id),
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  unit_count INTEGER NOT NULL CHECK (unit_count > 0),
  balance_before_count INTEGER,
  balance_after_count INTEGER,
  record_status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  submitted_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  reviewed_at TIMESTAMPTZ,
  message TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  idempotency_key VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (recharge_type IN ('NEW', 'REFUND') AND original_recharge_id IS NULL)
    OR (recharge_type = 'VOID' AND original_recharge_id IS NOT NULL)
  ),
  CHECK (
    (recharge_type = 'REFUND' AND balance_before_count IS NOT NULL AND balance_before_count >= 0)
    OR (recharge_type <> 'REFUND' AND balance_before_count IS NULL AND balance_after_count IS NULL)
  ),
  CHECK (balance_after_count IS NULL OR (recharge_type = 'REFUND' AND record_status = 'APPROVED' AND balance_after_count >= 0))
);

-- Each verification is one order with a workflow status and a business tag.
CREATE TABLE public.verification_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verification_code VARCHAR(32) NOT NULL UNIQUE
    DEFAULT ('VX' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || LPAD(nextval('public.verification_code_seq')::TEXT, 4, '0')),
  verification_type VARCHAR(16) NOT NULL DEFAULT 'NORMAL'
    CHECK (verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  teacher_id BIGINT NOT NULL REFERENCES public.teachers(id),
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  unit_count INTEGER NOT NULL DEFAULT 1 CHECK (unit_count = 1),
  record_status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED', 'VOIDED')),
  submitted_by_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  reviewed_at TIMESTAMPTZ,
  message TEXT NOT NULL DEFAULT '',
  supplement_note TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  void_note TEXT NOT NULL DEFAULT '',
  voided_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  voided_at TIMESTAMPTZ,
  face_request_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (verification_type = 'SUPPLEMENT' OR supplement_note = ''),
  CHECK (
    (record_status = 'VOIDED' AND voided_by_account_id IS NOT NULL AND voided_at IS NOT NULL)
    OR
    (record_status <> 'VOIDED' AND voided_by_account_id IS NULL AND voided_at IS NULL AND void_note = '')
  )
);

-- Per-customer, per-product totals for the customer home page.
CREATE TABLE public.customer_product_balances (
  customer_id BIGINT NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  total_recharge_count INTEGER NOT NULL DEFAULT 0 CHECK (total_recharge_count >= 0),
  total_verification_count INTEGER NOT NULL DEFAULT 0 CHECK (total_verification_count >= 0),
  remaining_count INTEGER NOT NULL DEFAULT 0 CHECK (remaining_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, product_id),
  CONSTRAINT customer_product_balances_count_equation
    CHECK (remaining_count = GREATEST(total_recharge_count - total_verification_count, 0))
);

-- The audit trail belongs to the original order; no extra approval document is created.
CREATE TABLE public.record_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_type VARCHAR(16) NOT NULL CHECK (record_type IN ('RECHARGE', 'VERIFICATION')),
  record_id BIGINT NOT NULL,
  previous_status VARCHAR(16),
  current_status VARCHAR(16) NOT NULL CHECK (current_status IN ('PENDING', 'APPROVED', 'REJECTED', 'VOIDED')),
  changed_by_account_id BIGINT REFERENCES public.staff_accounts(id),
  change_note TEXT NOT NULL DEFAULT '',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_staff_accounts_role_status ON public.staff_accounts (role_code, account_status);
CREATE INDEX idx_stores_lookup ON public.stores (store_name, province, city, district);
CREATE INDEX idx_store_contacts_store_status ON public.store_contacts (store_id, contact_status);
CREATE INDEX idx_teachers_name_status ON public.teachers (teacher_name, teacher_status);
CREATE INDEX idx_products_name_status ON public.products (product_name, product_status);
CREATE UNIQUE INDEX uq_products_normalized_name
  ON public.products (LOWER(BTRIM(product_name)));
CREATE UNIQUE INDEX uq_products_idempotency_key
  ON public.products (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_customers_store_name ON public.customers (created_store_id, customer_name);
CREATE INDEX idx_customers_active_store_lookup
  ON public.customers (created_store_id, customer_name, birth_date, id)
  WHERE customer_status = 'ACTIVE';
CREATE INDEX idx_recharge_customer_cursor ON public.recharge_records (customer_id, submitted_at DESC, id DESC);
CREATE INDEX idx_recharge_store_cursor ON public.recharge_records (store_id, submitted_at DESC, id DESC);
CREATE INDEX idx_recharge_teacher_cursor ON public.recharge_records (teacher_id, submitted_at DESC, id DESC)
  WHERE teacher_id IS NOT NULL;
CREATE INDEX idx_recharge_status_time ON public.recharge_records (record_status, submitted_at DESC);
CREATE INDEX idx_recharge_pending_review_cursor
  ON public.recharge_records (submitted_at DESC, id DESC)
  WHERE record_status = 'PENDING';
CREATE INDEX idx_recharge_approved_balance
  ON public.recharge_records (customer_id, product_id, recharge_type)
  INCLUDE (unit_count, submitted_at)
  WHERE record_status = 'APPROVED';
CREATE INDEX idx_recharge_product_store_cursor
  ON public.recharge_records (product_id, store_id, submitted_at DESC, id DESC);
CREATE INDEX idx_recharge_product_teacher_cursor
  ON public.recharge_records (product_id, teacher_id, submitted_at DESC, id DESC)
  WHERE teacher_id IS NOT NULL;
CREATE INDEX idx_recharge_store_type_cursor
  ON public.recharge_records (store_id, recharge_type, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');
CREATE INDEX idx_recharge_store_type_status_cursor
  ON public.recharge_records (store_id, recharge_type, record_status, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');
CREATE INDEX idx_recharge_type_cursor
  ON public.recharge_records (recharge_type, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');
CREATE INDEX idx_recharge_type_product_store_cursor
  ON public.recharge_records (product_id, store_id, recharge_type, submitted_at DESC, id DESC)
  WHERE recharge_type IN ('NEW', 'REFUND');
CREATE INDEX idx_recharge_submitted_brin
  ON public.recharge_records USING BRIN (submitted_at) WITH (pages_per_range = 128);
CREATE UNIQUE INDEX uq_recharge_idempotency_key
  ON public.recharge_records (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_verification_customer_cursor ON public.verification_records (customer_id, submitted_at DESC, id DESC);
CREATE INDEX idx_verification_store_cursor ON public.verification_records (store_id, submitted_at DESC, id DESC);
CREATE INDEX idx_verification_teacher_cursor ON public.verification_records (teacher_id, submitted_at DESC, id DESC);
CREATE INDEX idx_verification_status_time ON public.verification_records (record_status, submitted_at DESC);
CREATE INDEX idx_verification_pending_review_cursor
  ON public.verification_records (submitted_at DESC, id DESC)
  WHERE record_status = 'PENDING';
CREATE INDEX idx_verification_approved_balance
  ON public.verification_records (customer_id, product_id, verification_type)
  INCLUDE (unit_count, submitted_at)
  WHERE record_status = 'APPROVED';
CREATE INDEX idx_verification_product_store_cursor
  ON public.verification_records (product_id, store_id, submitted_at DESC, id DESC);
CREATE INDEX idx_verification_product_teacher_cursor
  ON public.verification_records (product_id, teacher_id, submitted_at DESC, id DESC);
CREATE INDEX idx_verification_submitted_brin
  ON public.verification_records USING BRIN (submitted_at) WITH (pages_per_range = 128);
CREATE INDEX idx_customer_product_balances_product
  ON public.customer_product_balances (product_id, customer_id);
CREATE INDEX idx_history_record_cursor ON public.record_status_history (record_type, record_id, changed_at DESC, id DESC);

COMMENT ON COLUMN public.customers.profile_photo_file_id IS
  'Private CloudBase Storage object reference only. Never store image bytes, base64 data, or a signed public URL here.';
COMMENT ON COLUMN public.verification_records.face_request_id IS
  'Tencent face API request identifier only. Live verification image bytes are not retained in PostgreSQL.';

CREATE OR REPLACE FUNCTION public.assign_staff_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role_code IS DISTINCT FROM OLD.role_code THEN
    RAISE EXCEPTION 'account role cannot be changed';
  END IF;
  IF NEW.staff_code IS NULL OR BTRIM(NEW.staff_code) = '' THEN
    NEW.staff_code = CASE NEW.role_code
      WHEN 'hq' THEN 'HQ' || LPAD(nextval('public.hq_account_code_seq')::TEXT, 3, '0')
      WHEN 'operation' THEN 'OP' || LPAD(nextval('public.operation_account_code_seq')::TEXT, 3, '0')
      WHEN 'teacher' THEN 'TCH' || LPAD(nextval('public.teacher_account_code_seq')::TEXT, 3, '0')
      WHEN 'store' THEN 'STA' || LPAD(nextval('public.store_account_code_seq')::TEXT, 3, '0')
    END;
  END IF;
  RETURN NEW;
END;
$$;

-- A teacher login automatically owns exactly one teacher master record.
CREATE OR REPLACE FUNCTION public.sync_teacher_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role_code = 'teacher' THEN
    INSERT INTO public.teachers (teacher_name, staff_account_id, teacher_status)
    VALUES (NEW.staff_name, NEW.id, NEW.account_status)
    ON CONFLICT (staff_account_id) DO UPDATE
    SET teacher_name = EXCLUDED.teacher_name,
        teacher_status = EXCLUDED.teacher_status,
        updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_operation_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  account_role VARCHAR(16);
BEGIN
  SELECT role_code INTO account_role
  FROM public.staff_accounts
  WHERE id = NEW.operation_account_id;
  IF account_role IS DISTINCT FROM 'operation' THEN
    RAISE EXCEPTION 'operation scope requires an operation account';
  END IF;
  RETURN NEW;
END;
$$;

-- A customer can receive orders only from the store that owns the profile.
CREATE OR REPLACE FUNCTION public.validate_order_customer_store()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  customer_store_id BIGINT;
  current_customer_status VARCHAR(16);
BEGIN
  SELECT created_store_id, customer_status
  INTO customer_store_id, current_customer_status
  FROM public.customers
  WHERE id = NEW.customer_id;
  IF customer_store_id IS NULL OR customer_store_id <> NEW.store_id THEN
    RAISE EXCEPTION 'order store must match customer store';
  END IF;
  IF current_customer_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'archived customer cannot receive a new order';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_assign_staff_code
BEFORE INSERT OR UPDATE OF role_code ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.assign_staff_code();

CREATE TRIGGER trg_sync_teacher_profile
AFTER INSERT OR UPDATE OF staff_name, account_status, role_code ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_profile();

CREATE TRIGGER trg_staff_accounts_updated_at
BEFORE UPDATE ON public.staff_accounts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_stores_updated_at
BEFORE UPDATE ON public.stores
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_store_contacts_updated_at
BEFORE UPDATE ON public.store_contacts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_teachers_updated_at
BEFORE UPDATE ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_customers_updated_at
BEFORE UPDATE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_operation_scopes_updated_at
BEFORE UPDATE ON public.operation_store_scopes
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_validate_operation_scope
BEFORE INSERT OR UPDATE OF operation_account_id ON public.operation_store_scopes
FOR EACH ROW EXECUTE FUNCTION public.validate_operation_scope();

CREATE TRIGGER trg_recharge_updated_at
BEFORE UPDATE ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_validate_recharge_customer_store
BEFORE INSERT OR UPDATE OF store_id, customer_id ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.validate_order_customer_store();

CREATE TRIGGER trg_verification_updated_at
BEFORE UPDATE ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_validate_verification_customer_store
BEFORE INSERT OR UPDATE OF store_id, customer_id ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.validate_order_customer_store();

CREATE OR REPLACE FUNCTION public.validate_verification_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.record_status = 'VOIDED' THEN
      RAISE EXCEPTION 'a verification cannot be created in VOIDED status'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    IF OLD.record_status = 'PENDING'
       AND NEW.record_status NOT IN ('APPROVED', 'REJECTED') THEN
      RAISE EXCEPTION 'invalid verification transition: % -> %', OLD.record_status, NEW.record_status
        USING ERRCODE = '23514';
    ELSIF OLD.record_status IN ('APPROVED', 'REJECTED', 'VOIDED') THEN
      RAISE EXCEPTION 'verification status % is terminal', OLD.record_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_verification_status_transition
BEFORE INSERT OR UPDATE OF record_status
ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.validate_verification_status_transition();

-- Recalculate all customer totals from approved original orders. The customer
-- row is locked first, so concurrent approvals serialize on the same customer.
CREATE OR REPLACE FUNCTION public.refresh_customer_balance(p_customer_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM public.customers WHERE id = p_customer_id FOR UPDATE;

  DELETE FROM public.customer_product_balances
  WHERE customer_id = p_customer_id;

  INSERT INTO public.customer_product_balances
    (customer_id, product_id, total_recharge_count, total_verification_count, remaining_count, updated_at)
  WITH recharge_totals AS (
    SELECT customer_id, product_id,
      GREATEST(SUM(CASE recharge_type WHEN 'NEW' THEN unit_count ELSE -unit_count END), 0)::INTEGER AS recharge_count
    FROM public.recharge_records
    WHERE customer_id = p_customer_id AND record_status = 'APPROVED'
    GROUP BY customer_id, product_id
  ), verification_totals AS (
    SELECT customer_id, product_id, SUM(unit_count)::INTEGER AS verification_count
    FROM public.verification_records
    WHERE customer_id = p_customer_id
      AND record_status = 'APPROVED'
      -- EXPERIENCE never consumes a purchased product unit. A voided original
      -- row is excluded because its record_status is no longer APPROVED.
      AND verification_type IN ('NORMAL', 'SUPPLEMENT')
    GROUP BY customer_id, product_id
  )
  SELECT
    COALESCE(r.customer_id, v.customer_id),
    COALESCE(r.product_id, v.product_id),
    COALESCE(r.recharge_count, 0),
    COALESCE(v.verification_count, 0),
    GREATEST(COALESCE(r.recharge_count, 0) - COALESCE(v.verification_count, 0), 0),
    NOW()
  FROM recharge_totals r
  FULL OUTER JOIN verification_totals v
    ON r.customer_id = v.customer_id AND r.product_id = v.product_id;

  UPDATE public.customers c
  SET
    total_recharge_count = COALESCE((SELECT SUM(b.total_recharge_count) FROM public.customer_product_balances b WHERE b.customer_id = c.id), 0),
    total_verification_count = COALESCE((SELECT SUM(v.unit_count) FROM public.verification_records v WHERE v.customer_id = c.id AND v.record_status = 'APPROVED' AND v.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')), 0),
    total_experience_count = COALESCE((SELECT SUM(v.unit_count) FROM public.verification_records v WHERE v.customer_id = c.id AND v.record_status = 'APPROVED' AND v.verification_type = 'EXPERIENCE'), 0),
    latest_recharge_at = (SELECT MAX(submitted_at) FROM public.recharge_records r WHERE r.customer_id = c.id AND r.record_status = 'APPROVED' AND r.recharge_type = 'NEW'),
    latest_verification_at = (SELECT MAX(submitted_at) FROM public.verification_records v WHERE v.customer_id = c.id AND v.record_status = 'APPROVED' AND v.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')),
    customer_process_status = CASE
      WHEN COALESCE((SELECT SUM(b.total_recharge_count) FROM public.customer_product_balances b WHERE b.customer_id = c.id), 0) = 0 THEN 'INFORMATION_ONLY'
      WHEN COALESCE((SELECT SUM(b.total_verification_count) FROM public.customer_product_balances b WHERE b.customer_id = c.id), 0) = 0 THEN 'RECHARGED_NO_CONSUMPTION'
      ELSE 'RECHARGED_WITH_CONSUMPTION'
    END
  WHERE c.id = p_customer_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_customer_balance_after_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.refresh_customer_balance(COALESCE(NEW.customer_id, OLD.customer_id));
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_recharge_refresh_customer_balance
AFTER INSERT OR UPDATE OR DELETE
ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.refresh_customer_balance_after_order();

CREATE TRIGGER trg_verification_refresh_customer_balance
AFTER INSERT OR UPDATE OR DELETE
ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.refresh_customer_balance_after_order();

CREATE OR REPLACE FUNCTION public.write_order_status_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_type VARCHAR(16);
  changed_by BIGINT;
  changed_note TEXT;
BEGIN
  order_type = CASE TG_TABLE_NAME WHEN 'recharge_records' THEN 'RECHARGE' ELSE 'VERIFICATION' END;

  IF TG_TABLE_NAME = 'verification_records' AND NEW.record_status = 'VOIDED' THEN
    changed_by = NEW.voided_by_account_id;
    changed_note = COALESCE(NEW.void_note, '');
  ELSE
    changed_by = COALESCE(NEW.reviewed_by_account_id, NEW.submitted_by_account_id);
    changed_note = COALESCE(NULLIF(NEW.review_note, ''), NEW.message, '');
  END IF;
  IF TG_OP = 'INSERT' OR NEW.record_status IS DISTINCT FROM OLD.record_status THEN
    INSERT INTO public.record_status_history
      (record_type, record_id, previous_status, current_status, changed_by_account_id, change_note)
    VALUES
      (order_type, NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.record_status END,
       NEW.record_status, changed_by, changed_note);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_recharge_status_history
AFTER INSERT OR UPDATE OF record_status ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.write_order_status_history();

CREATE TRIGGER trg_verification_status_history
AFTER INSERT OR UPDATE OF record_status ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.write_order_status_history();

COMMIT;

-- Store management system: initial CloudBase PostgreSQL schema.
-- Run this file in the CloudBase SQL editor.
-- This schema stores business identifiers and audit results only. Do not store face photos, secret keys, or ID-card images here.

CREATE TABLE IF NOT EXISTS public.staff_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_uid VARCHAR(64) NOT NULL UNIQUE,
  phone CHAR(11) NOT NULL UNIQUE,
  staff_name VARCHAR(64) NOT NULL,
  role_code VARCHAR(16) NOT NULL CHECK (role_code IN ('hq', 'operation', 'store', 'teacher')),
  account_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_role_status ON public.staff_accounts (role_code, account_status);

CREATE TABLE IF NOT EXISTS public.stores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_code VARCHAR(32) NOT NULL UNIQUE,
  store_name VARCHAR(100) NOT NULL,
  province VARCHAR(32) NOT NULL,
  city VARCHAR(32) NOT NULL,
  district VARCHAR(32) NOT NULL,
  address_detail VARCHAR(255) NOT NULL,
  contacts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  store_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (store_status IN ('ACTIVE', 'ARCHIVED')),
  created_by BIGINT REFERENCES public.staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_lookup ON public.stores (store_name, province, city, district);

CREATE TABLE IF NOT EXISTS public.staff_store_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  assignment_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (assignment_status IN ('ACTIVE', 'ARCHIVED')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_account_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_assignment_store ON public.staff_store_assignments (store_id, assignment_status);
-- Each store may have only one active store account. Archive the old assignment before binding a replacement phone number.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_store_account_per_store
  ON public.staff_store_assignments (store_id)
  WHERE assignment_status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS public.teachers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  teacher_code VARCHAR(32) NOT NULL UNIQUE,
  staff_account_id BIGINT UNIQUE REFERENCES public.staff_accounts(id),
  teacher_name VARCHAR(64) NOT NULL,
  -- Encrypt the raw ID-card value in a cloud function. Use the SHA-256 hash only for lookup and deduplication.
  id_card_ciphertext BYTEA NOT NULL,
  id_card_hash CHAR(64) NOT NULL UNIQUE,
  phone CHAR(11) NOT NULL,
  teacher_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (teacher_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teacher_name ON public.teachers (teacher_name);

CREATE TABLE IF NOT EXISTS public.products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_code VARCHAR(32) NOT NULL UNIQUE,
  product_name VARCHAR(100) NOT NULL,
  product_type VARCHAR(32) NOT NULL,
  price_cent INTEGER NOT NULL CHECK (price_cent >= 0),
  product_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (product_status IN ('ACTIVE', 'ARCHIVED')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_status ON public.products (product_status);

CREATE TABLE IF NOT EXISTS public.customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_code VARCHAR(32) NOT NULL UNIQUE,
  customer_name VARCHAR(64) NOT NULL,
  phone CHAR(11),
  -- Tencent Cloud face-library PersonId. Do not store face images or biometric feature vectors.
  face_person_id VARCHAR(128) UNIQUE,
  face_consent_at TIMESTAMPTZ,
  customer_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (customer_status IN ('ACTIVE', 'ARCHIVED')),
  created_store_id BIGINT NOT NULL REFERENCES public.stores(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_phone ON public.customers (phone);
CREATE INDEX IF NOT EXISTS idx_customer_store ON public.customers (created_store_id);

CREATE TABLE IF NOT EXISTS public.recharge_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recharge_code VARCHAR(32) NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  -- This relationship may be optional by business configuration, but the column is retained for teacher traceability.
  teacher_id BIGINT REFERENCES public.teachers(id),
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  amount_cent INTEGER NOT NULL CHECK (amount_cent >= 0),
  payment_status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'REJECTED', 'VOID')),
  created_by BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recharge_customer_time ON public.recharge_records (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_store_time ON public.recharge_records (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_teacher_time ON public.recharge_records (teacher_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.verification_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verification_code VARCHAR(32) NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  -- This relationship may be optional by business configuration, but the column is retained for teacher traceability.
  teacher_id BIGINT REFERENCES public.teachers(id),
  face_request_id VARCHAR(128),
  face_score NUMERIC(6,3),
  verification_status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING', 'SUCCESS', 'FAILED', 'REVIEW_REQUIRED', 'VOID')),
  verified_by BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_customer_time ON public.verification_records (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_store_time ON public.verification_records (store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_staff_id BIGINT REFERENCES public.staff_accounts(id),
  action_code VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  detail_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON public.audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON public.audit_logs (actor_staff_id, created_at DESC);

-- Deny direct client access to business tables by default. Use role-aware cloud functions for reads and writes.
ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_store_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recharge_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

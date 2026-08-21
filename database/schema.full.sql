-- Complete CloudBase PostgreSQL business schema.
-- Safe for an empty database and additive for the current database.
-- All SQL text is ASCII-only.
-- This base schema is followed by the ordered migration chain; execute through
-- 053_retire_legacy_teacher_face_saga.sql before deploying current functions.
-- Migrations 046--050 install and repair teacher quota/face business data;
-- 051--052 are immutable historical orchestration migrations, and 053 removes
-- that retired operation state without deleting teachers or business history.

BEGIN;

CREATE TABLE IF NOT EXISTS public.staff_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_uid VARCHAR(64) NOT NULL UNIQUE,
  phone CHAR(11) NOT NULL UNIQUE,
  staff_name VARCHAR(64) NOT NULL,
  role_code VARCHAR(16) NOT NULL CHECK (role_code IN ('hq', 'store', 'teacher')),
  account_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS public.teachers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  teacher_code VARCHAR(32) NOT NULL UNIQUE,
  staff_account_id BIGINT UNIQUE REFERENCES public.staff_accounts(id),
  teacher_name VARCHAR(64) NOT NULL,
  id_card_ciphertext BYTEA NOT NULL,
  id_card_hash CHAR(64) NOT NULL UNIQUE,
  phone CHAR(11) NOT NULL,
  teacher_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (teacher_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_code VARCHAR(32) NOT NULL UNIQUE,
  product_name VARCHAR(100) NOT NULL,
  product_type VARCHAR(32) NOT NULL,
  product_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (product_status IN ('ACTIVE', 'ARCHIVED')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.customers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_code VARCHAR(32) NOT NULL UNIQUE,
  customer_name VARCHAR(64) NOT NULL,
  birth_date DATE,
  notes TEXT NOT NULL DEFAULT '',
  profile_photo_file_id VARCHAR(512),
  photo_captured_at TIMESTAMPTZ,
  face_person_id VARCHAR(128) UNIQUE,
  face_consent_at TIMESTAMPTZ,
  customer_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (customer_status IN ('ACTIVE', 'ARCHIVED')),
  customer_process_status VARCHAR(32) NOT NULL DEFAULT 'INFORMATION_ONLY' CHECK (customer_process_status IN ('INFORMATION_ONLY', 'RECHARGED_NO_CONSUMPTION', 'RECHARGED_WITH_CONSUMPTION')),
  total_recharge_count INTEGER NOT NULL DEFAULT 0 CHECK (total_recharge_count >= 0),
  total_verification_count INTEGER NOT NULL DEFAULT 0 CHECK (total_verification_count >= 0),
  total_experience_count INTEGER NOT NULL DEFAULT 0 CHECK (total_experience_count >= 0),
  created_store_id BIGINT NOT NULL REFERENCES public.stores(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.staff_store_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  assignment_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (assignment_status IN ('ACTIVE', 'ARCHIVED')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_account_id, store_id)
);

CREATE TABLE IF NOT EXISTS public.store_contacts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  contact_name VARCHAR(64) NOT NULL,
  contact_phone CHAR(11) NOT NULL,
  contact_title VARCHAR(64),
  contact_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (contact_status IN ('ACTIVE', 'ARCHIVED')),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.hq_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_account_id BIGINT NOT NULL UNIQUE REFERENCES public.staff_accounts(id),
  profile_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (profile_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.operation_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_account_id BIGINT NOT NULL UNIQUE REFERENCES public.staff_accounts(id),
  profile_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (profile_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.operation_store_scopes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_staff_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  scope_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (scope_status IN ('ACTIVE', 'ARCHIVED')),
  assigned_by BIGINT REFERENCES public.staff_accounts(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (operation_staff_id, store_id)
);

CREATE TABLE IF NOT EXISTS public.access_roles (
  role_code VARCHAR(16) PRIMARY KEY,
  role_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (role_status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_code VARCHAR(16) NOT NULL REFERENCES public.access_roles(role_code),
  permission_code VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS public.account_role_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
  role_code VARCHAR(16) NOT NULL REFERENCES public.access_roles(role_code),
  grant_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (grant_status IN ('ACTIVE', 'ARCHIVED')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by BIGINT REFERENCES public.staff_accounts(id),
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.account_identity_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
  subject_type VARCHAR(16) NOT NULL CHECK (subject_type IN ('hq', 'operation', 'teacher', 'store')),
  subject_id BIGINT NOT NULL,
  link_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (link_status IN ('ACTIVE', 'ARCHIVED')),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by BIGINT REFERENCES public.staff_accounts(id),
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.recharge_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recharge_code VARCHAR(32) NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  teacher_id BIGINT REFERENCES public.teachers(id),
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  unit_count INTEGER NOT NULL DEFAULT 1 CHECK (unit_count > 0),
  idempotency_key VARCHAR(64),
  payment_status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'REJECTED', 'VOID')),
  record_status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_by BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  note TEXT,
  voided_at TIMESTAMPTZ,
  voided_by BIGINT REFERENCES public.staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.verification_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verification_code VARCHAR(32) NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  teacher_id BIGINT REFERENCES public.teachers(id),
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  verification_tag VARCHAR(24) NOT NULL DEFAULT 'NORMAL' CHECK (verification_tag IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')),
  idempotency_key VARCHAR(64),
  record_status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  face_status VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED' CHECK (face_status IN ('NOT_STARTED', 'PASSED', 'FAILED', 'ERROR')),
  face_request_id VARCHAR(128),
  face_score NUMERIC(6,3),
  verification_status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING', 'SUCCESS', 'FAILED', 'REVIEW_REQUIRED', 'VOID')),
  verified_by BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  verified_at TIMESTAMPTZ,
  note TEXT,
  voided_at TIMESTAMPTZ,
  voided_by BIGINT REFERENCES public.staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS record_status VARCHAR(24) NOT NULL DEFAULT 'PENDING';
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES public.staff_accounts(id);
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS teacher_id BIGINT REFERENCES public.teachers(id);
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES public.products(id);
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS unit_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.recharge_records ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS record_status VARCHAR(24) NOT NULL DEFAULT 'PENDING';
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS verification_tag VARCHAR(24) NOT NULL DEFAULT 'NORMAL';
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS face_status VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES public.staff_accounts(id);
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS teacher_id BIGINT REFERENCES public.teachers(id);
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES public.products(id);
ALTER TABLE public.verification_records ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

ALTER TABLE public.recharge_records DROP CONSTRAINT IF EXISTS recharge_records_record_status_check;
ALTER TABLE public.recharge_records ADD CONSTRAINT recharge_records_record_status_check CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE public.verification_records DROP CONSTRAINT IF EXISTS verification_records_record_status_check;
ALTER TABLE public.verification_records ADD CONSTRAINT verification_records_record_status_check CHECK (record_status IN ('PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE public.verification_records DROP CONSTRAINT IF EXISTS verification_records_verification_tag_check;
ALTER TABLE public.verification_records ADD CONSTRAINT verification_records_verification_tag_check CHECK (verification_tag IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE'));
ALTER TABLE public.verification_records DROP CONSTRAINT IF EXISTS verification_records_face_status_check;
ALTER TABLE public.verification_records ADD CONSTRAINT verification_records_face_status_check CHECK (face_status IN ('NOT_STARTED', 'PASSED', 'FAILED', 'ERROR'));
ALTER TABLE public.recharge_records DROP CONSTRAINT IF EXISTS recharge_records_teacher_required;
ALTER TABLE public.recharge_records ADD CONSTRAINT recharge_records_teacher_required CHECK (teacher_id IS NOT NULL) NOT VALID;
ALTER TABLE public.verification_records DROP CONSTRAINT IF EXISTS verification_records_teacher_required;
ALTER TABLE public.verification_records ADD CONSTRAINT verification_records_teacher_required CHECK (teacher_id IS NOT NULL) NOT VALID;
ALTER TABLE public.recharge_records DROP CONSTRAINT IF EXISTS recharge_records_product_required;
ALTER TABLE public.recharge_records ADD CONSTRAINT recharge_records_product_required CHECK (product_id IS NOT NULL) NOT VALID;
ALTER TABLE public.verification_records DROP CONSTRAINT IF EXISTS verification_records_product_required;
ALTER TABLE public.verification_records ADD CONSTRAINT verification_records_product_required CHECK (product_id IS NOT NULL) NOT VALID;
ALTER TABLE public.recharge_records DROP CONSTRAINT IF EXISTS recharge_records_unit_count_check;
ALTER TABLE public.recharge_records ADD CONSTRAINT recharge_records_unit_count_check CHECK (unit_count > 0);

UPDATE public.recharge_records SET record_status = CASE payment_status WHEN 'PAID' THEN 'APPROVED' WHEN 'REJECTED' THEN 'REJECTED' WHEN 'VOID' THEN 'REJECTED' ELSE 'PENDING' END WHERE record_status NOT IN ('PENDING', 'APPROVED', 'REJECTED') OR (record_status = 'PENDING' AND payment_status <> 'PENDING');
UPDATE public.verification_records SET record_status = CASE verification_status WHEN 'SUCCESS' THEN 'APPROVED' WHEN 'FAILED' THEN 'REJECTED' WHEN 'VOID' THEN 'REJECTED' ELSE 'PENDING' END WHERE record_status NOT IN ('PENDING', 'APPROVED', 'REJECTED') OR (record_status = 'PENDING' AND verification_status <> 'PENDING');

CREATE TABLE IF NOT EXISTS public.record_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_type VARCHAR(16) NOT NULL CHECK (record_type IN ('recharge', 'verification')),
  record_id BIGINT NOT NULL,
  previous_status VARCHAR(24),
  current_status VARCHAR(24) NOT NULL,
  changed_by BIGINT REFERENCES public.staff_accounts(id),
  change_note TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.business_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_code VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id BIGINT NOT NULL,
  actor_staff_id BIGINT REFERENCES public.staff_accounts(id),
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.customer_product_balances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES public.customers(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  product_id BIGINT NOT NULL REFERENCES public.products(id),
  approved_recharge_units BIGINT NOT NULL DEFAULT 0 CHECK (approved_recharge_units >= 0),
  approved_verification_units BIGINT NOT NULL DEFAULT 0 CHECK (approved_verification_units >= 0),
  remaining_units BIGINT NOT NULL DEFAULT 0 CHECK (remaining_units >= 0),
  row_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, store_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_role_status ON public.staff_accounts (role_code, account_status);
CREATE INDEX IF NOT EXISTS idx_store_lookup ON public.stores (store_name, province, city, district);
CREATE INDEX IF NOT EXISTS idx_teacher_name ON public.teachers (teacher_name);
CREATE INDEX IF NOT EXISTS idx_customer_store ON public.customers (created_store_id);
CREATE INDEX IF NOT EXISTS idx_customer_store_name_birth_active ON public.customers (created_store_id, customer_name, birth_date) WHERE customer_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_assignment_store ON public.staff_store_assignments (store_id, assignment_status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_store_account_per_store ON public.staff_store_assignments (store_id) WHERE assignment_status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_primary_store_contact ON public.store_contacts (store_id) WHERE is_primary = TRUE AND contact_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_operation_scope_active ON public.operation_store_scopes (operation_staff_id, store_id) WHERE scope_status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_role_per_account ON public.account_role_assignments (account_id) WHERE grant_status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_identity_per_account ON public.account_identity_links (account_id) WHERE link_status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_account_per_subject ON public.account_identity_links (subject_type, subject_id) WHERE link_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_recharge_store_time ON public.recharge_records (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_teacher_time ON public.recharge_records (teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_product_store_time ON public.recharge_records (product_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_store_time ON public.verification_records (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_teacher_time ON public.verification_records (teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_product_store_time ON public.verification_records (product_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_record_status_history_lookup ON public.record_status_history (record_type, record_id, changed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recharge_idempotency_key ON public.recharge_records (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_idempotency_key ON public.verification_records (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_product_balance_lookup ON public.customer_product_balances (customer_id, store_id, product_id);

INSERT INTO public.access_roles (role_code) VALUES ('hq'), ('store'), ('teacher') ON CONFLICT (role_code) DO NOTHING;
INSERT INTO public.role_permissions (role_code, permission_code) VALUES
  ('hq', 'global.read.all'), ('hq', 'master.write.all'), ('hq', 'account.manage'), ('hq', 'record.approve'),
  ('store', 'global.read.own_store'), ('store', 'record.write.own_store'),
  ('teacher', 'global.read.own'), ('teacher', 'record.write.own')
ON CONFLICT (role_code, permission_code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.sync_teacher_account_status() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.staff_account_id IS NOT NULL THEN UPDATE public.staff_accounts SET account_status = CASE WHEN NEW.teacher_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END, updated_at = NOW() WHERE id = NEW.staff_account_id; END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.sync_account_role_assignment() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN UPDATE public.account_role_assignments SET grant_status = 'ARCHIVED', archived_at = NOW() WHERE account_id = NEW.id AND grant_status = 'ACTIVE' AND (role_code <> NEW.role_code OR NEW.account_status = 'ARCHIVED'); IF NEW.account_status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM public.account_role_assignments WHERE account_id = NEW.id AND role_code = NEW.role_code AND grant_status = 'ACTIVE') THEN INSERT INTO public.account_role_assignments (account_id, role_code, grant_status) VALUES (NEW.id, NEW.role_code, 'ACTIVE'); ELSIF NEW.account_status = 'ARCHIVED' AND NOT EXISTS (SELECT 1 FROM public.account_role_assignments WHERE account_id = NEW.id AND role_code = NEW.role_code AND grant_status = 'ARCHIVED') THEN INSERT INTO public.account_role_assignments (account_id, role_code, grant_status, archived_at) VALUES (NEW.id, NEW.role_code, 'ARCHIVED', NOW()); END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.create_staff_profile_for_role() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.role_code = 'hq' THEN INSERT INTO public.hq_profiles (staff_account_id, profile_status) VALUES (NEW.id, NEW.account_status) ON CONFLICT (staff_account_id) DO NOTHING; ELSIF NEW.role_code = 'operation' THEN INSERT INTO public.operation_profiles (staff_account_id, profile_status) VALUES (NEW.id, NEW.account_status) ON CONFLICT (staff_account_id) DO NOTHING; END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.sync_identity_link() RETURNS TRIGGER LANGUAGE plpgsql AS $$ DECLARE kind VARCHAR(16); DECLARE source_status VARCHAR(16); BEGIN kind := TG_ARGV[0]; source_status := COALESCE(to_jsonb(NEW)->>'profile_status', to_jsonb(NEW)->>'teacher_status'); UPDATE public.account_identity_links SET link_status = 'ARCHIVED', archived_at = NOW() WHERE account_id = NEW.staff_account_id AND link_status = 'ACTIVE' AND (subject_type <> kind OR subject_id <> NEW.id); IF NOT EXISTS (SELECT 1 FROM public.account_identity_links WHERE account_id = NEW.staff_account_id AND subject_type = kind AND subject_id = NEW.id AND link_status = 'ACTIVE') THEN INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status) VALUES (NEW.staff_account_id, kind, NEW.id, CASE WHEN source_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END); END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.sync_store_identity_link() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.assignment_status = 'ACTIVE' THEN UPDATE public.account_identity_links SET link_status = 'ARCHIVED', archived_at = NOW() WHERE account_id = NEW.staff_account_id AND link_status = 'ACTIVE' AND (subject_type <> 'store' OR subject_id <> NEW.store_id); IF NOT EXISTS (SELECT 1 FROM public.account_identity_links WHERE account_id = NEW.staff_account_id AND subject_type = 'store' AND subject_id = NEW.store_id AND link_status = 'ACTIVE') THEN INSERT INTO public.account_identity_links (account_id, subject_type, subject_id) VALUES (NEW.staff_account_id, 'store', NEW.store_id); END IF; ELSE UPDATE public.account_identity_links SET link_status = 'ARCHIVED', archived_at = NOW() WHERE account_id = NEW.staff_account_id AND subject_type = 'store' AND subject_id = NEW.store_id AND link_status = 'ACTIVE'; END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.validate_recharge_record_transition() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'UPDATE' AND NEW.record_status IS DISTINCT FROM OLD.record_status AND NOT ((OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED', 'REJECTED')) OR (OLD.record_status = 'APPROVED' AND NEW.record_status = 'REJECTED')) THEN RAISE EXCEPTION 'invalid recharge status transition'; END IF; NEW.payment_status = CASE NEW.record_status WHEN 'PENDING' THEN 'PENDING' WHEN 'APPROVED' THEN 'PAID' WHEN 'REJECTED' THEN 'REJECTED' END; NEW.status_changed_at = NOW(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.validate_verification_record_transition() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'UPDATE' AND NEW.record_status IS DISTINCT FROM OLD.record_status AND NOT ((OLD.record_status = 'PENDING' AND NEW.record_status IN ('APPROVED', 'REJECTED')) OR (OLD.record_status = 'APPROVED' AND NEW.record_status = 'REJECTED')) THEN RAISE EXCEPTION 'invalid verification status transition'; END IF; NEW.verification_status = CASE NEW.record_status WHEN 'PENDING' THEN 'PENDING' WHEN 'APPROVED' THEN 'SUCCESS' WHEN 'REJECTED' THEN 'FAILED' END; NEW.status_changed_at = NOW(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.log_recharge_record_status() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'INSERT' OR NEW.record_status IS DISTINCT FROM OLD.record_status THEN INSERT INTO public.record_status_history (record_type, record_id, previous_status, current_status, changed_by, change_note) VALUES ('recharge', NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.record_status END, NEW.record_status, COALESCE(NEW.voided_by, NEW.created_by), NEW.note); END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.log_verification_record_status() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'INSERT' OR NEW.record_status IS DISTINCT FROM OLD.record_status THEN INSERT INTO public.record_status_history (record_type, record_id, previous_status, current_status, changed_by, change_note) VALUES ('verification', NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.record_status END, NEW.record_status, COALESCE(NEW.voided_by, NEW.verified_by), NEW.note); END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.touch_customer_product_balance() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.row_version = OLD.row_version + 1; NEW.updated_at = NOW(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.apply_recharge_balance() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'INSERT' THEN IF NEW.record_status = 'APPROVED' THEN INSERT INTO public.customer_product_balances (customer_id, store_id, product_id, approved_recharge_units, remaining_units) VALUES (NEW.customer_id, NEW.store_id, NEW.product_id, NEW.unit_count, NEW.unit_count) ON CONFLICT (customer_id, store_id, product_id) DO UPDATE SET approved_recharge_units = customer_product_balances.approved_recharge_units + EXCLUDED.approved_recharge_units, remaining_units = customer_product_balances.remaining_units + EXCLUDED.remaining_units; END IF; RETURN NEW; END IF; IF OLD.record_status = 'PENDING' AND NEW.record_status = 'APPROVED' THEN INSERT INTO public.customer_product_balances (customer_id, store_id, product_id, approved_recharge_units, remaining_units) VALUES (NEW.customer_id, NEW.store_id, NEW.product_id, NEW.unit_count, NEW.unit_count) ON CONFLICT (customer_id, store_id, product_id) DO UPDATE SET approved_recharge_units = customer_product_balances.approved_recharge_units + EXCLUDED.approved_recharge_units, remaining_units = customer_product_balances.remaining_units + EXCLUDED.remaining_units; ELSIF OLD.record_status = 'APPROVED' AND NEW.record_status = 'REJECTED' THEN UPDATE public.customer_product_balances SET approved_recharge_units = approved_recharge_units - OLD.unit_count, remaining_units = remaining_units - OLD.unit_count WHERE customer_id = OLD.customer_id AND store_id = OLD.store_id AND product_id = OLD.product_id AND remaining_units >= OLD.unit_count; IF NOT FOUND THEN RAISE EXCEPTION 'cannot reject recharge after consumed units exist'; END IF; END IF; RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.apply_verification_balance() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'INSERT' THEN IF NEW.record_status = 'APPROVED' THEN UPDATE public.customer_product_balances SET approved_verification_units = approved_verification_units + 1, remaining_units = remaining_units - 1 WHERE customer_id = NEW.customer_id AND store_id = NEW.store_id AND product_id = NEW.product_id AND remaining_units >= 1; IF NOT FOUND THEN RAISE EXCEPTION 'insufficient remaining units for verification'; END IF; END IF; RETURN NEW; END IF; IF OLD.record_status = 'PENDING' AND NEW.record_status = 'APPROVED' THEN UPDATE public.customer_product_balances SET approved_verification_units = approved_verification_units + 1, remaining_units = remaining_units - 1 WHERE customer_id = NEW.customer_id AND store_id = NEW.store_id AND product_id = NEW.product_id AND remaining_units >= 1; IF NOT FOUND THEN RAISE EXCEPTION 'insufficient remaining units for verification'; END IF; ELSIF OLD.record_status = 'APPROVED' AND NEW.record_status = 'REJECTED' THEN UPDATE public.customer_product_balances SET approved_verification_units = approved_verification_units - 1, remaining_units = remaining_units + 1 WHERE customer_id = OLD.customer_id AND store_id = OLD.store_id AND product_id = OLD.product_id; IF NOT FOUND THEN RAISE EXCEPTION 'verification balance row not found'; END IF; END IF; RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_stores ON public.stores;
CREATE TRIGGER trg_touch_stores BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_teachers ON public.teachers;
CREATE TRIGGER trg_touch_teachers BEFORE UPDATE ON public.teachers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_products ON public.products;
CREATE TRIGGER trg_touch_products BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_customers ON public.customers;
CREATE TRIGGER trg_touch_customers BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_store_contacts ON public.store_contacts;
CREATE TRIGGER trg_touch_store_contacts BEFORE UPDATE ON public.store_contacts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_recharge ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_touch_recharge_records ON public.recharge_records;
CREATE TRIGGER trg_touch_recharge BEFORE UPDATE ON public.recharge_records FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_verification ON public.verification_records;
DROP TRIGGER IF EXISTS trg_touch_verification_records ON public.verification_records;
CREATE TRIGGER trg_touch_verification BEFORE UPDATE ON public.verification_records FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_sync_teacher_account_status ON public.teachers;
CREATE TRIGGER trg_sync_teacher_account_status AFTER INSERT OR UPDATE OF teacher_status, staff_account_id ON public.teachers FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_account_status();
DROP TRIGGER IF EXISTS trg_sync_account_role ON public.staff_accounts;
DROP TRIGGER IF EXISTS trg_sync_account_role_assignment ON public.staff_accounts;
CREATE TRIGGER trg_sync_account_role AFTER INSERT OR UPDATE OF role_code, account_status ON public.staff_accounts FOR EACH ROW EXECUTE FUNCTION public.sync_account_role_assignment();
DROP TRIGGER IF EXISTS trg_create_staff_profile ON public.staff_accounts;
DROP TRIGGER IF EXISTS trg_create_staff_profile_for_role ON public.staff_accounts;
CREATE TRIGGER trg_create_staff_profile AFTER INSERT ON public.staff_accounts FOR EACH ROW EXECUTE FUNCTION public.create_staff_profile_for_role();
DROP TRIGGER IF EXISTS trg_hq_identity_link ON public.hq_profiles;
CREATE TRIGGER trg_hq_identity_link AFTER INSERT OR UPDATE OF staff_account_id, profile_status ON public.hq_profiles FOR EACH ROW EXECUTE FUNCTION public.sync_identity_link('hq');
DROP TRIGGER IF EXISTS trg_operation_identity_link ON public.operation_profiles;
CREATE TRIGGER trg_operation_identity_link AFTER INSERT OR UPDATE OF staff_account_id, profile_status ON public.operation_profiles FOR EACH ROW EXECUTE FUNCTION public.sync_identity_link('operation');
DROP TRIGGER IF EXISTS trg_teacher_identity_link ON public.teachers;
CREATE TRIGGER trg_teacher_identity_link AFTER INSERT OR UPDATE OF staff_account_id, teacher_status ON public.teachers FOR EACH ROW EXECUTE FUNCTION public.sync_identity_link('teacher');
DROP TRIGGER IF EXISTS trg_store_identity_link ON public.staff_store_assignments;
CREATE TRIGGER trg_store_identity_link AFTER INSERT OR UPDATE OF staff_account_id, store_id, assignment_status ON public.staff_store_assignments FOR EACH ROW EXECUTE FUNCTION public.sync_store_identity_link();
DROP TRIGGER IF EXISTS trg_validate_recharge_status ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_validate_recharge_record_transition ON public.recharge_records;
CREATE TRIGGER trg_validate_recharge_status BEFORE INSERT OR UPDATE OF record_status ON public.recharge_records FOR EACH ROW EXECUTE FUNCTION public.validate_recharge_record_transition();
DROP TRIGGER IF EXISTS trg_validate_verification_status ON public.verification_records;
DROP TRIGGER IF EXISTS trg_validate_verification_record_transition ON public.verification_records;
CREATE TRIGGER trg_validate_verification_status BEFORE INSERT OR UPDATE OF record_status ON public.verification_records FOR EACH ROW EXECUTE FUNCTION public.validate_verification_record_transition();
DROP TRIGGER IF EXISTS trg_log_recharge_status ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_log_recharge_record_status ON public.recharge_records;
CREATE TRIGGER trg_log_recharge_status BEFORE INSERT OR UPDATE OF record_status ON public.recharge_records FOR EACH ROW EXECUTE FUNCTION public.log_recharge_record_status();
DROP TRIGGER IF EXISTS trg_log_verification_status ON public.verification_records;
DROP TRIGGER IF EXISTS trg_log_verification_record_status ON public.verification_records;
CREATE TRIGGER trg_log_verification_status BEFORE INSERT OR UPDATE OF record_status ON public.verification_records FOR EACH ROW EXECUTE FUNCTION public.log_verification_record_status();
DROP TRIGGER IF EXISTS trg_touch_customer_product_balance ON public.customer_product_balances;
CREATE TRIGGER trg_touch_customer_product_balance BEFORE UPDATE ON public.customer_product_balances FOR EACH ROW EXECUTE FUNCTION public.touch_customer_product_balance();
DROP TRIGGER IF EXISTS trg_apply_recharge_balance ON public.recharge_records;
CREATE TRIGGER trg_apply_recharge_balance AFTER INSERT OR UPDATE OF record_status ON public.recharge_records FOR EACH ROW EXECUTE FUNCTION public.apply_recharge_balance();
DROP TRIGGER IF EXISTS trg_apply_verification_balance ON public.verification_records;
CREATE TRIGGER trg_apply_verification_balance AFTER INSERT OR UPDATE OF record_status ON public.verification_records FOR EACH ROW EXECUTE FUNCTION public.apply_verification_balance();

INSERT INTO public.hq_profiles (staff_account_id, profile_status) SELECT id, account_status FROM public.staff_accounts WHERE role_code = 'hq' ON CONFLICT (staff_account_id) DO NOTHING;
INSERT INTO public.operation_profiles (staff_account_id, profile_status) SELECT id, account_status FROM public.staff_accounts WHERE role_code = 'operation' ON CONFLICT (staff_account_id) DO NOTHING;
INSERT INTO public.account_role_assignments (account_id, role_code, grant_status) SELECT id, role_code, CASE WHEN account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END FROM public.staff_accounts WHERE NOT EXISTS (SELECT 1 FROM public.account_role_assignments r WHERE r.account_id = staff_accounts.id AND r.role_code = staff_accounts.role_code AND r.grant_status = CASE WHEN staff_accounts.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END) ON CONFLICT DO NOTHING;
INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status) SELECT staff_account_id, 'hq', id, profile_status FROM public.hq_profiles WHERE NOT EXISTS (SELECT 1 FROM public.account_identity_links l WHERE l.account_id = hq_profiles.staff_account_id AND l.subject_type = 'hq' AND l.subject_id = hq_profiles.id) ON CONFLICT DO NOTHING;
INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status) SELECT staff_account_id, 'operation', id, profile_status FROM public.operation_profiles WHERE NOT EXISTS (SELECT 1 FROM public.account_identity_links l WHERE l.account_id = operation_profiles.staff_account_id AND l.subject_type = 'operation' AND l.subject_id = operation_profiles.id) ON CONFLICT DO NOTHING;
INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status) SELECT staff_account_id, 'teacher', id, teacher_status FROM public.teachers WHERE staff_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_identity_links l WHERE l.account_id = teachers.staff_account_id AND l.subject_type = 'teacher' AND l.subject_id = teachers.id) ON CONFLICT DO NOTHING;
INSERT INTO public.account_identity_links (account_id, subject_type, subject_id, link_status) SELECT staff_account_id, 'store', store_id, assignment_status FROM public.staff_store_assignments WHERE NOT EXISTS (SELECT 1 FROM public.account_identity_links l WHERE l.account_id = staff_store_assignments.staff_account_id AND l.subject_type = 'store' AND l.subject_id = staff_store_assignments.store_id) ON CONFLICT DO NOTHING;

INSERT INTO public.record_status_history (record_type, record_id, current_status, changed_by, changed_at) SELECT 'recharge', id, record_status, created_by, created_at FROM public.recharge_records WHERE NOT EXISTS (SELECT 1 FROM public.record_status_history h WHERE h.record_type = 'recharge' AND h.record_id = recharge_records.id);
INSERT INTO public.record_status_history (record_type, record_id, current_status, changed_by, changed_at) SELECT 'verification', id, record_status, verified_by, created_at FROM public.verification_records WHERE NOT EXISTS (SELECT 1 FROM public.record_status_history h WHERE h.record_type = 'verification' AND h.record_id = verification_records.id);
INSERT INTO public.customer_product_balances (customer_id, store_id, product_id, approved_recharge_units, approved_verification_units, remaining_units) SELECT r.customer_id, r.store_id, r.product_id, COALESCE(SUM(r.unit_count) FILTER (WHERE r.record_status = 'APPROVED'), 0), COALESCE(v.approved_units, 0), GREATEST(COALESCE(SUM(r.unit_count) FILTER (WHERE r.record_status = 'APPROVED'), 0) - COALESCE(v.approved_units, 0), 0) FROM public.recharge_records r LEFT JOIN (SELECT customer_id, store_id, product_id, COUNT(*) AS approved_units FROM public.verification_records WHERE record_status = 'APPROVED' GROUP BY customer_id, store_id, product_id) v ON v.customer_id = r.customer_id AND v.store_id = r.store_id AND v.product_id = r.product_id WHERE r.product_id IS NOT NULL GROUP BY r.customer_id, r.store_id, r.product_id, v.approved_units ON CONFLICT (customer_id, store_id, product_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.current_staff_account_id() RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT id FROM public.staff_accounts WHERE auth_uid = auth.uid()::text AND account_status = 'ACTIVE' LIMIT 1; $$;
CREATE OR REPLACE FUNCTION public.current_staff_role() RETURNS VARCHAR LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT role_code FROM public.staff_accounts WHERE id = public.current_staff_account_id() LIMIT 1; $$;
CREATE OR REPLACE FUNCTION public.current_teacher_id() RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT id FROM public.teachers WHERE staff_account_id = public.current_staff_account_id() AND teacher_status = 'ACTIVE' LIMIT 1; $$;
CREATE OR REPLACE FUNCTION public.has_store_scope(target_store_id BIGINT) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT CASE WHEN public.current_staff_role() = 'hq' THEN TRUE WHEN public.current_staff_role() = 'store' THEN EXISTS (SELECT 1 FROM public.staff_store_assignments a WHERE a.staff_account_id = public.current_staff_account_id() AND a.store_id = target_store_id AND a.assignment_status = 'ACTIVE') WHEN public.current_staff_role() = 'operation' THEN EXISTS (SELECT 1 FROM public.operation_store_scopes s WHERE s.operation_staff_id = public.current_staff_account_id() AND s.store_id = target_store_id AND s.scope_status = 'ACTIVE') ELSE FALSE END; $$;

ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recharge_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.record_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_product_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_accounts_self_or_hq_read ON public.staff_accounts;
CREATE POLICY staff_accounts_self_or_hq_read ON public.staff_accounts FOR SELECT TO authenticated USING (id = public.current_staff_account_id() OR public.current_staff_role() = 'hq');
DROP POLICY IF EXISTS stores_scoped_read ON public.stores;
CREATE POLICY stores_scoped_read ON public.stores FOR SELECT TO authenticated USING (public.has_store_scope(id));
DROP POLICY IF EXISTS teachers_scoped_read ON public.teachers;
CREATE POLICY teachers_scoped_read ON public.teachers FOR SELECT TO authenticated USING (public.current_staff_role() = 'hq' OR id = public.current_teacher_id());
DROP POLICY IF EXISTS products_active_read ON public.products;
CREATE POLICY products_active_read ON public.products FOR SELECT TO authenticated USING (public.current_staff_role() = 'hq' OR product_status = 'ACTIVE');
DROP POLICY IF EXISTS customers_scoped_read ON public.customers;
CREATE POLICY customers_scoped_read ON public.customers FOR SELECT TO authenticated USING (public.has_store_scope(created_store_id));
DROP POLICY IF EXISTS recharge_scoped_read ON public.recharge_records;
CREATE POLICY recharge_scoped_read ON public.recharge_records FOR SELECT TO authenticated USING (public.has_store_scope(store_id) OR teacher_id = public.current_teacher_id());
DROP POLICY IF EXISTS verification_scoped_read ON public.verification_records;
CREATE POLICY verification_scoped_read ON public.verification_records FOR SELECT TO authenticated USING (public.has_store_scope(store_id) OR teacher_id = public.current_teacher_id());
DROP POLICY IF EXISTS record_status_history_scoped_read ON public.record_status_history;
CREATE POLICY record_status_history_scoped_read ON public.record_status_history FOR SELECT TO authenticated USING (public.current_staff_role() = 'hq');
DROP POLICY IF EXISTS account_identity_self_or_hq_read ON public.account_identity_links;
CREATE POLICY account_identity_self_or_hq_read ON public.account_identity_links FOR SELECT TO authenticated USING (account_id = public.current_staff_account_id() OR public.current_staff_role() = 'hq');
DROP POLICY IF EXISTS account_role_self_or_hq_read ON public.account_role_assignments;
CREATE POLICY account_role_self_or_hq_read ON public.account_role_assignments FOR SELECT TO authenticated USING (account_id = public.current_staff_account_id() OR public.current_staff_role() = 'hq');
DROP POLICY IF EXISTS customer_product_balance_scoped_read ON public.customer_product_balances;
CREATE POLICY customer_product_balance_scoped_read ON public.customer_product_balances FOR SELECT TO authenticated USING (public.has_store_scope(store_id) OR EXISTS (SELECT 1 FROM public.recharge_records r WHERE r.customer_id = customer_product_balances.customer_id AND r.store_id = customer_product_balances.store_id AND r.product_id = customer_product_balances.product_id AND r.teacher_id = public.current_teacher_id()));

CREATE OR REPLACE VIEW public.v_account_access AS SELECT a.id AS account_id, a.auth_uid, a.phone, a.staff_name, a.account_status, l.subject_type, l.subject_id, r.role_code, ARRAY_AGG(p.permission_code ORDER BY p.permission_code) FILTER (WHERE p.permission_code IS NOT NULL) AS permissions FROM public.staff_accounts a LEFT JOIN public.account_identity_links l ON l.account_id = a.id AND l.link_status = 'ACTIVE' LEFT JOIN public.account_role_assignments r ON r.account_id = a.id AND r.grant_status = 'ACTIVE' LEFT JOIN public.role_permissions p ON p.role_code = r.role_code GROUP BY a.id, a.auth_uid, a.phone, a.staff_name, a.account_status, l.subject_type, l.subject_id, r.role_code;
CREATE OR REPLACE VIEW public.v_product_store_summary AS WITH x AS (SELECT product_id, store_id FROM public.recharge_records UNION SELECT product_id, store_id FROM public.verification_records) SELECT p.id AS product_id, s.id AS store_id, s.store_code, s.store_name, s.province, s.city, s.district, COUNT(DISTINCT r.id) FILTER (WHERE r.record_status = 'APPROVED') AS recharge_count, COUNT(DISTINCT v.id) FILTER (WHERE v.record_status = 'APPROVED') AS verification_count FROM x JOIN public.products p ON p.id = x.product_id JOIN public.stores s ON s.id = x.store_id LEFT JOIN public.recharge_records r ON r.product_id = x.product_id AND r.store_id = x.store_id LEFT JOIN public.verification_records v ON v.product_id = x.product_id AND v.store_id = x.store_id GROUP BY p.id, s.id, s.store_code, s.store_name, s.province, s.city, s.district;
CREATE OR REPLACE VIEW public.v_product_teacher_summary AS SELECT p.id AS product_id, t.id AS teacher_id, t.teacher_code, t.teacher_name, COUNT(v.id) FILTER (WHERE v.record_status = 'APPROVED') AS verification_count FROM public.products p JOIN public.verification_records v ON v.product_id = p.id JOIN public.teachers t ON t.id = v.teacher_id GROUP BY p.id, t.id, t.teacher_code, t.teacher_name;
CREATE OR REPLACE VIEW public.v_store_global_view AS SELECT s.id AS store_id, s.store_code, s.store_name, s.store_status, s.province, s.city, s.district, s.address_detail, COUNT(DISTINCT c.id) FILTER (WHERE c.customer_status = 'ACTIVE') AS active_customer_count, COUNT(DISTINCT r.id) FILTER (WHERE r.record_status = 'APPROVED') AS approved_recharge_count, COUNT(DISTINCT v.id) FILTER (WHERE v.record_status = 'APPROVED') AS approved_verification_count FROM public.stores s LEFT JOIN public.customers c ON c.created_store_id = s.id LEFT JOIN public.recharge_records r ON r.store_id = s.id LEFT JOIN public.verification_records v ON v.store_id = s.id GROUP BY s.id, s.store_code, s.store_name, s.store_status, s.province, s.city, s.district, s.address_detail;
CREATE OR REPLACE VIEW public.v_teacher_global_view AS SELECT t.id AS teacher_id, t.teacher_code, t.teacher_name, t.teacher_status, t.staff_account_id, COUNT(DISTINCT r.id) FILTER (WHERE r.record_status = 'APPROVED') AS approved_recharge_count, COUNT(DISTINCT v.id) FILTER (WHERE v.record_status = 'APPROVED') AS approved_verification_count FROM public.teachers t LEFT JOIN public.recharge_records r ON r.teacher_id = t.id LEFT JOIN public.verification_records v ON v.teacher_id = t.id GROUP BY t.id, t.teacher_code, t.teacher_name, t.teacher_status, t.staff_account_id;
CREATE OR REPLACE VIEW public.v_operation_global_view AS SELECT a.id AS operation_staff_id, a.staff_name, a.phone, a.account_status, COUNT(DISTINCT s.store_id) FILTER (WHERE s.scope_status = 'ACTIVE') AS active_store_scope_count, COUNT(DISTINCT r.id) FILTER (WHERE r.record_status = 'APPROVED') AS approved_recharge_count, COUNT(DISTINCT v.id) FILTER (WHERE v.record_status = 'APPROVED') AS approved_verification_count FROM public.staff_accounts a LEFT JOIN public.operation_store_scopes s ON s.operation_staff_id = a.id LEFT JOIN public.recharge_records r ON r.store_id = s.store_id LEFT JOIN public.verification_records v ON v.store_id = s.store_id WHERE a.role_code = 'operation' GROUP BY a.id, a.staff_name, a.phone, a.account_status;
CREATE OR REPLACE VIEW public.v_hq_global_view AS SELECT a.id AS hq_staff_id, a.staff_name, a.phone, a.account_status, (SELECT COUNT(*) FROM public.stores WHERE store_status = 'ACTIVE') AS active_store_count, (SELECT COUNT(*) FROM public.teachers WHERE teacher_status = 'ACTIVE') AS active_teacher_count, (SELECT COUNT(*) FROM public.customers WHERE customer_status = 'ACTIVE') AS active_customer_count, (SELECT COUNT(*) FROM public.products WHERE product_status = 'ACTIVE') AS active_product_count FROM public.staff_accounts a WHERE a.role_code = 'hq';

COMMIT;

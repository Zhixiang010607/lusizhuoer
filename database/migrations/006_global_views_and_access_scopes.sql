-- Business scope, global views, and read isolation.
-- This migration is additive and may be run after migrations 002-005.
-- All statements use ASCII-only SQL text.

BEGIN;

-- A single phone already maps to one row in staff_accounts.  This table gives
-- an operation account an explicit, auditable store scope.  An empty scope
-- grants no store business access.
CREATE TABLE IF NOT EXISTS public.operation_store_scopes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_staff_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  store_id BIGINT NOT NULL REFERENCES public.stores(id),
  scope_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (scope_status IN ('ACTIVE', 'ARCHIVED')),
  assigned_by BIGINT REFERENCES public.staff_accounts(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (operation_staff_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_operation_scope_active
  ON public.operation_store_scopes (operation_staff_id, store_id)
  WHERE scope_status = 'ACTIVE';

-- A store may expose several business contacts.  This is separate from the
-- single active login account enforced by staff_store_assignments.
CREATE TABLE IF NOT EXISTS public.store_contacts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  contact_name VARCHAR(64) NOT NULL,
  contact_phone CHAR(11) NOT NULL,
  contact_title VARCHAR(64),
  contact_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (contact_status IN ('ACTIVE', 'ARCHIVED')),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_primary_store_contact
  ON public.store_contacts (store_id)
  WHERE is_primary = TRUE AND contact_status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_store_contact_lookup
  ON public.store_contacts (contact_phone, contact_name, store_id);

-- Every recharge and verification is linked to a store, teacher, customer,
-- and product.  NOT VALID preserves legacy rows while enforcing the rule for
-- all new or modified rows after this migration.
ALTER TABLE public.recharge_records
  ADD COLUMN IF NOT EXISTS note TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES public.staff_accounts(id);

ALTER TABLE public.verification_records
  ADD COLUMN IF NOT EXISTS note TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES public.staff_accounts(id);

ALTER TABLE public.recharge_records
  DROP CONSTRAINT IF EXISTS recharge_records_teacher_required;
ALTER TABLE public.recharge_records
  ADD CONSTRAINT recharge_records_teacher_required
  CHECK (teacher_id IS NOT NULL) NOT VALID;

ALTER TABLE public.verification_records
  DROP CONSTRAINT IF EXISTS verification_records_teacher_required;
ALTER TABLE public.verification_records
  ADD CONSTRAINT verification_records_teacher_required
  CHECK (teacher_id IS NOT NULL) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_verification_teacher_time
  ON public.verification_records (teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_product_store_time
  ON public.recharge_records (product_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_product_store_time
  ON public.verification_records (product_id, store_id, created_at DESC);

-- Immutable operational audit trail for archive, approval, void, and binding
-- actions.  Detail stays structured and contains no biometric image data.
CREATE TABLE IF NOT EXISTS public.business_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_code VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id BIGINT NOT NULL,
  actor_staff_id BIGINT REFERENCES public.staff_accounts(id),
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_event_entity
  ON public.business_events (entity_type, entity_id, created_at DESC);

-- Shared update timestamp helper.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_store_contacts ON public.store_contacts;
CREATE TRIGGER trg_touch_store_contacts
BEFORE UPDATE ON public.store_contacts
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_recharge_records ON public.recharge_records;
CREATE TRIGGER trg_touch_recharge_records
BEFORE UPDATE ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_verification_records ON public.verification_records;
CREATE TRIGGER trg_touch_verification_records
BEFORE UPDATE ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Read-scope helpers used by row-level security.  Writes stay cloud-function
-- only; the client has no insert, update, or delete policy on business data.
CREATE OR REPLACE FUNCTION public.current_staff_account_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id
  FROM public.staff_accounts
  WHERE auth_uid = auth.uid()::text
    AND account_status = 'ACTIVE'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_staff_role()
RETURNS VARCHAR
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT role_code
  FROM public.staff_accounts
  WHERE id = public.current_staff_account_id()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_teacher_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id
  FROM public.teachers
  WHERE staff_account_id = public.current_staff_account_id()
    AND teacher_status = 'ACTIVE'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.has_store_scope(target_store_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN public.current_staff_role() = 'hq' THEN TRUE
    WHEN public.current_staff_role() = 'store' THEN EXISTS (
      SELECT 1
      FROM public.staff_store_assignments a
      WHERE a.staff_account_id = public.current_staff_account_id()
        AND a.store_id = target_store_id
        AND a.assignment_status = 'ACTIVE'
    )
    WHEN public.current_staff_role() = 'operation' THEN EXISTS (
      SELECT 1
      FROM public.operation_store_scopes s
      WHERE s.operation_staff_id = public.current_staff_account_id()
        AND s.store_id = target_store_id
        AND s.scope_status = 'ACTIVE'
    )
    ELSE FALSE
  END;
$$;

-- Read policies.  Headquarters can inspect all data.  Stores and operations
-- are limited to their assigned stores.  Teachers can inspect only records
-- carrying their own teacher_id.
ALTER TABLE public.operation_store_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_accounts_hq_read ON public.staff_accounts;
CREATE POLICY staff_accounts_hq_read
ON public.staff_accounts
FOR SELECT TO authenticated
USING (public.current_staff_role() = 'hq');

DROP POLICY IF EXISTS stores_scoped_read ON public.stores;
CREATE POLICY stores_scoped_read
ON public.stores
FOR SELECT TO authenticated
USING (public.has_store_scope(id));

DROP POLICY IF EXISTS store_contacts_scoped_read ON public.store_contacts;
CREATE POLICY store_contacts_scoped_read
ON public.store_contacts
FOR SELECT TO authenticated
USING (public.has_store_scope(store_id));

DROP POLICY IF EXISTS operation_scopes_read ON public.operation_store_scopes;
CREATE POLICY operation_scopes_read
ON public.operation_store_scopes
FOR SELECT TO authenticated
USING (
  public.current_staff_role() = 'hq'
  OR operation_staff_id = public.current_staff_account_id()
);

DROP POLICY IF EXISTS teachers_scoped_read ON public.teachers;
CREATE POLICY teachers_scoped_read
ON public.teachers
FOR SELECT TO authenticated
USING (
  public.current_staff_role() = 'hq'
  OR id = public.current_teacher_id()
);

DROP POLICY IF EXISTS products_active_read ON public.products;
CREATE POLICY products_active_read
ON public.products
FOR SELECT TO authenticated
USING (
  public.current_staff_role() = 'hq'
  OR product_status = 'ACTIVE'
);

DROP POLICY IF EXISTS customers_scoped_read ON public.customers;
CREATE POLICY customers_scoped_read
ON public.customers
FOR SELECT TO authenticated
USING (
  public.has_store_scope(created_store_id)
  OR EXISTS (
    SELECT 1 FROM public.recharge_records r
    WHERE r.customer_id = customers.id
      AND r.teacher_id = public.current_teacher_id()
  )
  OR EXISTS (
    SELECT 1 FROM public.verification_records v
    WHERE v.customer_id = customers.id
      AND v.teacher_id = public.current_teacher_id()
  )
);

DROP POLICY IF EXISTS recharge_scoped_read ON public.recharge_records;
CREATE POLICY recharge_scoped_read
ON public.recharge_records
FOR SELECT TO authenticated
USING (
  public.has_store_scope(store_id)
  OR teacher_id = public.current_teacher_id()
);

DROP POLICY IF EXISTS verification_scoped_read ON public.verification_records;
CREATE POLICY verification_scoped_read
ON public.verification_records
FOR SELECT TO authenticated
USING (
  public.has_store_scope(store_id)
  OR teacher_id = public.current_teacher_id()
);

DROP POLICY IF EXISTS verification_review_scoped_read ON public.verification_review_requests;
CREATE POLICY verification_review_scoped_read
ON public.verification_review_requests
FOR SELECT TO authenticated
USING (
  public.current_staff_role() = 'hq'
  OR teacher_id = public.current_teacher_id()
);

DROP POLICY IF EXISTS recharge_void_scoped_read ON public.recharge_void_requests;
CREATE POLICY recharge_void_scoped_read
ON public.recharge_void_requests
FOR SELECT TO authenticated
USING (
  public.current_staff_role() = 'hq'
  OR teacher_id = public.current_teacher_id()
);

DROP POLICY IF EXISTS business_events_hq_read ON public.business_events;
CREATE POLICY business_events_hq_read
ON public.business_events
FOR SELECT TO authenticated
USING (public.current_staff_role() = 'hq');

-- Global-view sources for the application.  Each original record remains the
-- source for an individual recharge or verification detail page.
CREATE OR REPLACE VIEW public.v_product_store_summary AS
WITH product_store_activity AS (
  SELECT product_id, store_id FROM public.recharge_records
  UNION
  SELECT product_id, store_id FROM public.verification_records
)
SELECT
  p.id AS product_id,
  s.id AS store_id,
  s.store_code,
  s.store_name,
  s.province,
  s.city,
  s.district,
  COUNT(DISTINCT r.id) FILTER (WHERE r.payment_status = 'PAID') AS recharge_count,
  COALESCE(SUM(r.amount_cent) FILTER (WHERE r.payment_status = 'PAID'), 0) AS recharge_amount_cent,
  COUNT(DISTINCT v.id) FILTER (WHERE v.verification_status = 'SUCCESS') AS verification_count,
  MAX(GREATEST(COALESCE(r.updated_at, r.created_at), COALESCE(v.updated_at, v.created_at))) AS latest_activity_at
FROM product_store_activity a
JOIN public.products p ON p.id = a.product_id
JOIN public.stores s ON s.id = a.store_id
LEFT JOIN public.recharge_records r ON r.product_id = a.product_id AND r.store_id = a.store_id
LEFT JOIN public.verification_records v ON v.product_id = a.product_id AND v.store_id = a.store_id
GROUP BY p.id, s.id, s.store_code, s.store_name, s.province, s.city, s.district;

CREATE OR REPLACE VIEW public.v_product_teacher_summary AS
SELECT
  p.id AS product_id,
  t.id AS teacher_id,
  t.teacher_code,
  t.teacher_name,
  COUNT(DISTINCT v.id) FILTER (WHERE v.verification_status = 'SUCCESS') AS verification_count,
  MAX(COALESCE(v.updated_at, v.created_at)) AS latest_verification_at
FROM public.products p
JOIN public.verification_records v ON v.product_id = p.id
JOIN public.teachers t ON t.id = v.teacher_id
GROUP BY p.id, t.id, t.teacher_code, t.teacher_name;

CREATE OR REPLACE VIEW public.v_store_global_view AS
SELECT
  s.id AS store_id,
  s.store_code,
  s.store_name,
  s.store_status,
  s.province,
  s.city,
  s.district,
  s.address_detail,
  COUNT(DISTINCT c.id) FILTER (WHERE c.customer_status = 'ACTIVE') AS active_customer_count,
  COUNT(DISTINCT r.id) FILTER (WHERE r.payment_status = 'PAID') AS paid_recharge_count,
  COUNT(DISTINCT v.id) FILTER (WHERE v.verification_status = 'SUCCESS') AS successful_verification_count
FROM public.stores s
LEFT JOIN public.customers c ON c.created_store_id = s.id
LEFT JOIN public.recharge_records r ON r.store_id = s.id
LEFT JOIN public.verification_records v ON v.store_id = s.id
GROUP BY s.id, s.store_code, s.store_name, s.store_status, s.province, s.city, s.district, s.address_detail;

CREATE OR REPLACE VIEW public.v_teacher_global_view AS
SELECT
  t.id AS teacher_id,
  t.teacher_code,
  t.teacher_name,
  t.teacher_status,
  t.staff_account_id,
  COUNT(DISTINCT r.id) FILTER (WHERE r.payment_status = 'PAID') AS paid_recharge_count,
  COUNT(DISTINCT v.id) FILTER (WHERE v.verification_status = 'SUCCESS') AS successful_verification_count,
  COUNT(DISTINCT vr.id) FILTER (WHERE vr.request_status = 'PENDING') AS pending_verification_review_count,
  COUNT(DISTINCT rr.id) FILTER (WHERE rr.request_status = 'PENDING') AS pending_recharge_void_count
FROM public.teachers t
LEFT JOIN public.recharge_records r ON r.teacher_id = t.id
LEFT JOIN public.verification_records v ON v.teacher_id = t.id
LEFT JOIN public.verification_review_requests vr ON vr.teacher_id = t.id
LEFT JOIN public.recharge_void_requests rr ON rr.teacher_id = t.id
GROUP BY t.id, t.teacher_code, t.teacher_name, t.teacher_status, t.staff_account_id;

CREATE OR REPLACE VIEW public.v_operation_global_view AS
SELECT
  a.id AS operation_staff_id,
  a.staff_name,
  a.phone,
  a.account_status,
  COUNT(DISTINCT s.store_id) FILTER (WHERE s.scope_status = 'ACTIVE') AS active_store_scope_count,
  COUNT(DISTINCT r.id) FILTER (WHERE r.payment_status = 'PAID') AS scoped_paid_recharge_count,
  COUNT(DISTINCT v.id) FILTER (WHERE v.verification_status = 'SUCCESS') AS scoped_successful_verification_count
FROM public.staff_accounts a
LEFT JOIN public.operation_store_scopes s ON s.operation_staff_id = a.id
LEFT JOIN public.recharge_records r ON r.store_id = s.store_id
LEFT JOIN public.verification_records v ON v.store_id = s.store_id
WHERE a.role_code = 'operation'
GROUP BY a.id, a.staff_name, a.phone, a.account_status;

CREATE OR REPLACE VIEW public.v_hq_global_view AS
SELECT
  a.id AS hq_staff_id,
  a.staff_name,
  a.phone,
  a.account_status,
  (SELECT COUNT(*) FROM public.stores WHERE store_status = 'ACTIVE') AS active_store_count,
  (SELECT COUNT(*) FROM public.teachers WHERE teacher_status = 'ACTIVE') AS active_teacher_count,
  (SELECT COUNT(*) FROM public.customers WHERE customer_status = 'ACTIVE') AS active_customer_count,
  (SELECT COUNT(*) FROM public.products WHERE product_status = 'ACTIVE') AS active_product_count
FROM public.staff_accounts a
WHERE a.role_code = 'hq';

COMMIT;

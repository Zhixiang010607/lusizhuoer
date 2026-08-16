-- Enable row-level security for the rebuilt business schema.
-- Run only after schema.rebuild.sql has completed successfully.
-- Browser clients are read-only under RLS. All create, update, review, and
-- archive operations must go through trusted CloudBase cloud functions.

BEGIN;

CREATE OR REPLACE FUNCTION public.current_staff_account_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id
  FROM public.staff_accounts
  WHERE auth_uid = auth.uid()::TEXT
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

CREATE OR REPLACE FUNCTION public.current_store_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id
  FROM public.stores
  WHERE store_account_id = public.current_staff_account_id()
    AND store_status = 'ACTIVE'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_hq()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.current_staff_role() = 'hq';
$$;

CREATE OR REPLACE FUNCTION public.has_store_scope(target_store_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN public.is_hq() THEN TRUE
    WHEN public.current_staff_role() = 'store' THEN public.current_store_id() = target_store_id
    WHEN public.current_staff_role() = 'operation' THEN EXISTS (
      SELECT 1
      FROM public.operation_store_scopes s
      WHERE s.operation_account_id = public.current_staff_account_id()
        AND s.store_id = target_store_id
        AND s.scope_status = 'ACTIVE'
    )
    ELSE FALSE
  END;
$$;

CREATE OR REPLACE FUNCTION public.teacher_can_read_customer(target_customer_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.current_staff_role() = 'teacher' AND (
    EXISTS (
      SELECT 1 FROM public.recharge_records r
      WHERE r.customer_id = target_customer_id
        AND r.teacher_id = public.current_teacher_id()
    )
    OR EXISTS (
      SELECT 1 FROM public.verification_records v
      WHERE v.customer_id = target_customer_id
        AND v.teacher_id = public.current_teacher_id()
    )
  );
$$;

ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_store_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recharge_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_product_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.record_status_history ENABLE ROW LEVEL SECURITY;

-- No FORCE ROW LEVEL SECURITY: trusted server-side Cloud Functions must retain
-- their service access for writes and review transactions.

DROP POLICY IF EXISTS staff_accounts_self_or_hq_read ON public.staff_accounts;
CREATE POLICY staff_accounts_self_or_hq_read
ON public.staff_accounts
FOR SELECT TO authenticated
USING (id = public.current_staff_account_id() OR public.is_hq());

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

DROP POLICY IF EXISTS teachers_self_or_hq_read ON public.teachers;
CREATE POLICY teachers_self_or_hq_read
ON public.teachers
FOR SELECT TO authenticated
USING (public.is_hq() OR id = public.current_teacher_id());

DROP POLICY IF EXISTS products_active_read ON public.products;
CREATE POLICY products_active_read
ON public.products
FOR SELECT TO authenticated
USING (public.is_hq() OR product_status = 'ACTIVE');

DROP POLICY IF EXISTS customers_scoped_read ON public.customers;
CREATE POLICY customers_scoped_read
ON public.customers
FOR SELECT TO authenticated
USING (
  public.has_store_scope(created_store_id)
  OR public.teacher_can_read_customer(id)
);

DROP POLICY IF EXISTS operation_scope_self_or_hq_read ON public.operation_store_scopes;
CREATE POLICY operation_scope_self_or_hq_read
ON public.operation_store_scopes
FOR SELECT TO authenticated
USING (
  public.is_hq()
  OR operation_account_id = public.current_staff_account_id()
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

DROP POLICY IF EXISTS customer_product_balance_scoped_read ON public.customer_product_balances;
CREATE POLICY customer_product_balance_scoped_read
ON public.customer_product_balances
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.customers c
    WHERE c.id = customer_product_balances.customer_id
      AND (
        public.has_store_scope(c.created_store_id)
        OR public.teacher_can_read_customer(c.id)
      )
  )
);

DROP POLICY IF EXISTS record_status_history_scoped_read ON public.record_status_history;
CREATE POLICY record_status_history_scoped_read
ON public.record_status_history
FOR SELECT TO authenticated
USING (
  public.is_hq()
  OR (
    record_type = 'RECHARGE'
    AND EXISTS (
      SELECT 1 FROM public.recharge_records r
      WHERE r.id = record_status_history.record_id
        AND (
          public.has_store_scope(r.store_id)
          OR r.teacher_id = public.current_teacher_id()
        )
    )
  )
  OR (
    record_type = 'VERIFICATION'
    AND EXISTS (
      SELECT 1 FROM public.verification_records v
      WHERE v.id = record_status_history.record_id
        AND (
          public.has_store_scope(v.store_id)
          OR v.teacher_id = public.current_teacher_id()
        )
    )
  )
);

COMMIT;

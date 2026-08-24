BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_business_teacher_matrix_v59()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_role TEXT;
  actor_teacher_id BIGINT;
  order_type TEXT;
  has_direct BOOLEAN;
  scope_ok BOOLEAN;
  scope_sql TEXT;
BEGIN
  -- BUSINESS_TEACHER_MATRIX_V59
  SELECT a.role_code INTO actor_role FROM public.staff_accounts a
   WHERE a.id = NEW.submitted_by_account_id AND a.account_status = 'ACTIVE' FOR SHARE;
  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'inactive submitter' USING ERRCODE = '23514';
  END IF;

  IF NEW.teacher_id IS NOT NULL THEN
    PERFORM 1 FROM public.teachers t
      JOIN public.staff_accounts a ON a.id = t.staff_account_id
     WHERE t.id = NEW.teacher_id AND t.teacher_status = 'ACTIVE'
       AND a.role_code = 'teacher' AND a.account_status = 'ACTIVE'
     FOR SHARE OF t, a;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inactive teacher' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF actor_role = 'store' THEN
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stores'
        AND column_name = 'store_account_id') INTO has_direct;
    IF has_direct THEN
      -- STORE_BINDING_CURRENT_V59
      scope_sql := 'SELECT TRUE FROM public.stores store WHERE store.id = $1 AND store.store_account_id = $2 AND store.store_status = ''ACTIVE'' FOR SHARE OF store';
    ELSIF TO_REGCLASS('public.staff_store_assignments') IS NOT NULL THEN
      -- STORE_BINDING_LEGACY_V59
      scope_sql := 'SELECT TRUE FROM public.staff_store_assignments assignment JOIN public.stores store ON store.id = assignment.store_id WHERE assignment.staff_account_id = $2 AND assignment.store_id = $1 AND assignment.assignment_status = ''ACTIVE'' AND store.store_status = ''ACTIVE'' FOR SHARE OF assignment, store';
    END IF;
    -- STORE_BINDING_DYNAMIC_V59
    IF scope_sql IS NOT NULL THEN
      EXECUTE scope_sql INTO scope_ok USING NEW.store_id, NEW.submitted_by_account_id;
    END IF;
    IF NOT COALESCE(scope_ok, FALSE) THEN
      RAISE EXCEPTION 'store scope denied' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'verification_records' THEN
      order_type := UPPER(COALESCE(TO_JSONB(NEW)->>'verification_type', ''));
      IF order_type <> 'NORMAL' THEN
        -- STORE_EXPERIENCE_DENIED_V59
        RAISE EXCEPTION 'store cannot submit EXPERIENCE' USING ERRCODE = '23514';
      END IF;
      IF NEW.teacher_id IS NULL THEN
        -- STORE_NORMAL_TEACHER_REQUIRED_V59
        RAISE EXCEPTION 'store NORMAL requires active teacher' USING ERRCODE = '23514';
      END IF;
    END IF;
    -- STORE_RECHARGE_REFUND_TEACHER_OPTIONAL_V59
    RETURN NEW;
  END IF;

  IF actor_role = 'teacher' THEN
    SELECT t.id INTO actor_teacher_id FROM public.teachers t
     WHERE t.staff_account_id = NEW.submitted_by_account_id
       AND t.teacher_status = 'ACTIVE' FOR SHARE;
    IF actor_teacher_id IS NULL OR NEW.teacher_id IS DISTINCT FROM actor_teacher_id THEN
      -- TEACHER_SELF_ATTRIBUTION_V59
      RAISE EXCEPTION 'teacher order must use own teacher' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'role denied' USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_business_teacher_matrix_v59() FROM PUBLIC;
COMMENT ON FUNCTION public.enforce_business_teacher_matrix_v59() IS 'Migration 059 matrix.';

COMMIT;

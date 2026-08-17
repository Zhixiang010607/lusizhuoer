BEGIN;

CREATE OR REPLACE FUNCTION public.review_order_application(
  p_record_type VARCHAR,
  p_record_id BIGINT,
  p_actor_account_id BIGINT,
  p_decision VARCHAR,
  p_note TEXT
)
RETURNS TABLE(record_id BIGINT, record_code TEXT, record_status TEXT,
              void_request_status TEXT, reviewed_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  actor_role TEXT;
  decision TEXT := UPPER(COALESCE(p_decision, ''));
  current_status TEXT;
  current_void_status TEXT;
  current_code TEXT;
  recharge_customer_id BIGINT;
  recharge_product_id BIGINT;
  recharge_units INTEGER;
  current_recharge_type TEXT;
  current_remaining BIGINT;
BEGIN
  SELECT role_code INTO actor_role
    FROM public.staff_accounts
   WHERE id = p_actor_account_id AND account_status = 'ACTIVE';
  IF actor_role NOT IN ('hq', 'operation') THEN
    RAISE EXCEPTION 'only headquarters or operations can review orders' USING ERRCODE = '42501';
  END IF;
  IF decision NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'decision must be APPROVED or REJECTED' USING ERRCODE = '22023';
  END IF;
  IF LENGTH(COALESCE(p_note, '')) > 1000 THEN
    RAISE EXCEPTION 'review note is too long' USING ERRCODE = '22001';
  END IF;

  IF UPPER(p_record_type) = 'RECHARGE' THEN
    SELECT record_status, void_request_status, recharge_code, customer_id, product_id,
           unit_count, recharge_type
      INTO current_status, current_void_status, current_code,
           recharge_customer_id, recharge_product_id, recharge_units, current_recharge_type
      FROM public.recharge_records WHERE id = p_record_id FOR UPDATE;
  ELSIF UPPER(p_record_type) = 'VERIFICATION' THEN
    SELECT record_status, void_request_status, verification_code
      INTO current_status, current_void_status, current_code
      FROM public.verification_records WHERE id = p_record_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'unsupported record type' USING ERRCODE = '22023';
  END IF;
  IF current_code IS NULL THEN RAISE EXCEPTION 'order does not exist' USING ERRCODE = 'P0002'; END IF;

  IF current_void_status = 'PENDING' THEN
    IF UPPER(p_record_type) = 'RECHARGE' THEN
      IF decision = 'APPROVED' THEN
        -- Serialize balance decisions with refresh_customer_balance().
        PERFORM 1
          FROM public.customers
         WHERE id = recharge_customer_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'customer does not exist' USING ERRCODE = 'P0002';
        END IF;

        SELECT
          COALESCE((
            SELECT SUM(CASE r.recharge_type WHEN 'NEW' THEN r.unit_count ELSE -r.unit_count END)
              FROM public.recharge_records r
             WHERE r.customer_id = recharge_customer_id
               AND r.product_id = recharge_product_id
               AND r.record_status = 'APPROVED'
          ), 0)
          - COALESCE((
            SELECT SUM(v.unit_count)
              FROM public.verification_records v
             WHERE v.customer_id = recharge_customer_id
               AND v.product_id = recharge_product_id
               AND v.record_status = 'APPROVED'
               AND v.verification_type IN ('NORMAL', 'SUPPLEMENT')
          ), 0)
          INTO current_remaining;

        IF current_remaining
             - CASE current_recharge_type WHEN 'NEW' THEN recharge_units ELSE -recharge_units END < 0 THEN
          RAISE EXCEPTION 'cannot approve recharge void: customer product balance would become negative'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      UPDATE public.recharge_records
         SET void_request_status = decision,
             void_reviewed_by_account_id = p_actor_account_id,
             void_review_note = BTRIM(COALESCE(p_note, '')), void_reviewed_at = NOW(),
             record_status = CASE WHEN decision = 'APPROVED' THEN 'VOIDED' ELSE 'APPROVED' END,
             voided_by_account_id = CASE WHEN decision = 'APPROVED' THEN p_actor_account_id ELSE NULL END,
             voided_at = CASE WHEN decision = 'APPROVED' THEN NOW() ELSE NULL END,
             updated_at = NOW()
       WHERE id = p_record_id;
    ELSE
      UPDATE public.verification_records
         SET void_request_status = decision,
             void_reviewed_by_account_id = p_actor_account_id,
             void_review_note = BTRIM(COALESCE(p_note, '')), void_reviewed_at = NOW(),
             record_status = CASE WHEN decision = 'APPROVED' THEN 'VOIDED' ELSE 'APPROVED' END,
             void_note = CASE WHEN decision = 'APPROVED' THEN void_request_note ELSE '' END,
             voided_by_account_id = CASE WHEN decision = 'APPROVED' THEN p_actor_account_id ELSE NULL END,
             voided_at = CASE WHEN decision = 'APPROVED' THEN NOW() ELSE NULL END,
             updated_at = NOW()
       WHERE id = p_record_id;
    END IF;
    current_status := CASE WHEN decision = 'APPROVED' THEN 'VOIDED' ELSE 'APPROVED' END;
    current_void_status := decision;
  ELSE
    IF current_void_status <> 'NONE' OR current_status <> 'PENDING' THEN
      RAISE EXCEPTION 'this application is no longer pending' USING ERRCODE = '23514';
    END IF;
    IF UPPER(p_record_type) = 'RECHARGE' THEN
      UPDATE public.recharge_records
         SET record_status = decision, reviewed_by_account_id = p_actor_account_id,
             reviewed_at = NOW(), review_note = BTRIM(p_note), updated_at = NOW()
       WHERE id = p_record_id;
    ELSE
      UPDATE public.verification_records
         SET record_status = decision, reviewed_by_account_id = p_actor_account_id,
             reviewed_at = NOW(), review_note = BTRIM(p_note), updated_at = NOW()
       WHERE id = p_record_id;
    END IF;
    current_status := decision;
  END IF;

  RETURN QUERY SELECT p_record_id, current_code, current_status, current_void_status, NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.review_order_application(VARCHAR, BIGINT, BIGINT, VARCHAR, TEXT) FROM PUBLIC;

COMMIT;

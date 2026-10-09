-- Migration 072: reserve NORMAL balance or EXPERIENCE quota before any BLE
-- authorization is issued. The reservation is attached to the existing
-- 90-second qualification, so rescanning the same qualification is idempotent
-- while concurrent qualifications cannot overbook the same units.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.verification_ble_qualifications') IS NULL
     OR TO_REGCLASS('public.verification_ble_authorizations') IS NULL
     OR TO_REGCLASS('public.customer_product_balances') IS NULL
     OR TO_REGCLASS('public.teacher_product_experience_quotas') IS NULL THEN
    RAISE EXCEPTION 'migration 072 prerequisites are missing; execute migrations through 071 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'migration 072 requires the CloudBase service_role';
  END IF;
END;
$$;

LOCK TABLE public.verification_ble_qualifications IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_ble_authorizations IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.verification_ble_qualifications
  ADD COLUMN IF NOT EXISTS units_reserved_at TIMESTAMPTZ;

-- Existing live authorizations were validly issued by the immediately prior
-- runtime. Refuse the migration if they are already overbooked; otherwise
-- backfill their qualification reservation before the new runtime is enabled.
DO $$
DECLARE
  conflict_count BIGINT := 0;
BEGIN
  SELECT COUNT(*) INTO conflict_count
    FROM (
      SELECT qualification.customer_id, qualification.product_id
        FROM public.verification_ble_qualifications AS qualification
        JOIN public.verification_ble_authorizations AS ble_authorization
          ON ble_authorization.qualification_id = qualification.id
        LEFT JOIN public.customer_product_balances AS balance
          ON balance.customer_id = qualification.customer_id
         AND balance.product_id = qualification.product_id
       WHERE qualification.verification_type = 'NORMAL'
         AND qualification.verification_id IS NULL
         AND qualification.expires_at > CLOCK_TIMESTAMP()
         AND (
           ble_authorization.authorization_status = 'DEVICE_WORKING'
           OR (
             ble_authorization.authorization_status = 'ISSUED'
             AND ble_authorization.expires_at > CLOCK_TIMESTAMP()
           )
         )
       GROUP BY qualification.customer_id, qualification.product_id,
                balance.remaining_count
      HAVING SUM(qualification.unit_count) > COALESCE(balance.remaining_count, 0)
    ) AS conflict;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'migration 072 found % overbooked NORMAL BLE balance bucket(s)', conflict_count;
  END IF;

  SELECT COUNT(*) INTO conflict_count
    FROM (
      SELECT qualification.teacher_id, qualification.product_id
        FROM public.verification_ble_qualifications AS qualification
        JOIN public.verification_ble_authorizations AS ble_authorization
          ON ble_authorization.qualification_id = qualification.id
        LEFT JOIN public.teacher_product_experience_quotas AS quota
          ON quota.teacher_id = qualification.teacher_id
         AND quota.product_id = qualification.product_id
         AND quota.quota_status = 'ACTIVE'
       WHERE qualification.verification_type = 'EXPERIENCE'
         AND qualification.verification_id IS NULL
         AND qualification.expires_at > CLOCK_TIMESTAMP()
         AND (
           ble_authorization.authorization_status = 'DEVICE_WORKING'
           OR (
             ble_authorization.authorization_status = 'ISSUED'
             AND ble_authorization.expires_at > CLOCK_TIMESTAMP()
           )
         )
       GROUP BY qualification.teacher_id, qualification.product_id,
                quota.available_count
      HAVING SUM(qualification.unit_count) > COALESCE(quota.available_count, 0)
    ) AS conflict;
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'migration 072 found % overbooked EXPERIENCE BLE quota bucket(s)', conflict_count;
  END IF;
END;
$$;

UPDATE public.verification_ble_qualifications AS qualification
   SET units_reserved_at = COALESCE(qualification.units_reserved_at, ble_authorization.issued_at),
       updated_at = CLOCK_TIMESTAMP()
  FROM public.verification_ble_authorizations AS ble_authorization
 WHERE ble_authorization.qualification_id = qualification.id
   AND qualification.verification_id IS NULL
   AND qualification.expires_at > CLOCK_TIMESTAMP()
   AND (
     ble_authorization.authorization_status = 'DEVICE_WORKING'
     OR (
       ble_authorization.authorization_status = 'ISSUED'
       AND ble_authorization.expires_at > CLOCK_TIMESTAMP()
     )
   );

CREATE INDEX IF NOT EXISTS idx_verification_ble_qualification_unit_reservation
  ON public.verification_ble_qualifications
  (verification_type, customer_id, product_id, teacher_id, expires_at)
  WHERE units_reserved_at IS NOT NULL AND verification_id IS NULL;

CREATE OR REPLACE FUNCTION public.reserve_verification_ble_units(
  p_qualification_id BIGINT
)
RETURNS TABLE(
  verification_type TEXT,
  requested_unit_count INTEGER,
  available_before BIGINT,
  reserved_other BIGINT,
  available_after BIGINT,
  newly_reserved BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  qualification public.verification_ble_qualifications%ROWTYPE;
  quota public.teacher_product_experience_quotas%ROWTYPE;
  current_available BIGINT := 0;
  other_reserved BIGINT := 0;
  materialized_remaining BIGINT := 0;
  purchased_units BIGINT := 0;
  consumed_units BIGINT := 0;
  had_reservation BOOLEAN := FALSE;
BEGIN
  IF p_qualification_id IS NULL OR p_qualification_id <= 0 THEN
    RAISE EXCEPTION 'BLE qualification id is required for unit reservation'
      USING ERRCODE = '22023';
  END IF;

  SELECT qualification_row.* INTO qualification
    FROM public.verification_ble_qualifications AS qualification_row
   WHERE qualification_row.id = p_qualification_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLE qualification does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF qualification.verification_id IS NOT NULL
     OR qualification.qualification_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'BLE qualification is already finalized'
      USING ERRCODE = '23514';
  END IF;
  IF qualification.qualification_status IN ('EXPIRED', 'CANCELLED')
     OR qualification.expires_at <= CLOCK_TIMESTAMP() THEN
    RAISE EXCEPTION 'BLE qualification is not active'
      USING ERRCODE = '23514';
  END IF;
  IF qualification.unit_count < 1 OR qualification.unit_count > 999 THEN
    RAISE EXCEPTION 'BLE qualification unit count is invalid'
      USING ERRCODE = '23514';
  END IF;

  had_reservation := qualification.units_reserved_at IS NOT NULL;

  IF qualification.verification_type = 'NORMAL' THEN
    PERFORM pg_advisory_xact_lock(hashtext(
      'BLE_NORMAL:' || qualification.customer_id::TEXT || ':' || qualification.product_id::TEXT
    ));
    PERFORM 1
      FROM public.customers AS customer
     WHERE customer.id = qualification.customer_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BLE qualification customer does not exist'
        USING ERRCODE = '23503';
    END IF;

    SELECT GREATEST(balance.remaining_count, 0)::BIGINT
      INTO materialized_remaining
      FROM public.customer_product_balances AS balance
     WHERE balance.customer_id = qualification.customer_id
       AND balance.product_id = qualification.product_id
     FOR UPDATE;
    materialized_remaining := COALESCE(materialized_remaining, 0);

    SELECT GREATEST(COALESCE(SUM(
             CASE WHEN recharge.recharge_type = 'NEW'
                  THEN recharge.unit_count ELSE -recharge.unit_count END
           ), 0), 0)::BIGINT
      INTO purchased_units
      FROM public.recharge_records AS recharge
     WHERE recharge.customer_id = qualification.customer_id
       AND recharge.product_id = qualification.product_id
       AND recharge.record_status = 'APPROVED';

    SELECT COALESCE(SUM(record.unit_count), 0)::BIGINT
      INTO consumed_units
      FROM public.verification_records AS record
     WHERE record.customer_id = qualification.customer_id
       AND record.product_id = qualification.product_id
       AND record.record_status = 'APPROVED'
       AND record.verification_type IN ('NORMAL', 'SUPPLEMENT');

    current_available := LEAST(
      materialized_remaining,
      GREATEST(purchased_units - consumed_units, 0)
    );

    SELECT COALESCE(SUM(other.unit_count), 0)::BIGINT
      INTO other_reserved
      FROM public.verification_ble_qualifications AS other
     WHERE other.id <> qualification.id
       AND other.verification_type = 'NORMAL'
       AND other.customer_id = qualification.customer_id
       AND other.product_id = qualification.product_id
       AND other.units_reserved_at IS NOT NULL
       AND other.verification_id IS NULL
       AND other.qualification_status NOT IN ('COMPLETED', 'EXPIRED', 'CANCELLED')
       AND other.expires_at > CLOCK_TIMESTAMP();

    IF current_available - other_reserved < qualification.unit_count THEN
      RAISE EXCEPTION 'insufficient purchased units for BLE authorization'
        USING ERRCODE = '23514';
    END IF;
  ELSIF qualification.verification_type = 'EXPERIENCE' THEN
    IF qualification.teacher_id IS NULL THEN
      RAISE EXCEPTION 'BLE experience qualification has no teacher'
        USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext(
      'BLE_EXPERIENCE:' || qualification.teacher_id::TEXT || ':' || qualification.product_id::TEXT
    ));

    SELECT quota_row.* INTO quota
      FROM public.teacher_product_experience_quotas AS quota_row
     WHERE quota_row.teacher_id = qualification.teacher_id
       AND quota_row.product_id = qualification.product_id
       AND quota_row.quota_status = 'ACTIVE'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'teacher has no active configured experience quota for BLE authorization'
        USING ERRCODE = '23514';
    END IF;
    quota := public.reset_teacher_experience_quota(
      quota.id, public.teacher_experience_quota_month(), NULL
    );
    IF quota.quota_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'teacher has no active configured experience quota for BLE authorization'
        USING ERRCODE = '23514';
    END IF;
    current_available := GREATEST(quota.available_count, 0);

    SELECT COALESCE(SUM(other.unit_count), 0)::BIGINT
      INTO other_reserved
      FROM public.verification_ble_qualifications AS other
     WHERE other.id <> qualification.id
       AND other.verification_type = 'EXPERIENCE'
       AND other.teacher_id = qualification.teacher_id
       AND other.product_id = qualification.product_id
       AND other.units_reserved_at IS NOT NULL
       AND other.verification_id IS NULL
       AND other.qualification_status NOT IN ('COMPLETED', 'EXPIRED', 'CANCELLED')
       AND other.expires_at > CLOCK_TIMESTAMP();

    IF current_available - other_reserved < qualification.unit_count THEN
      RAISE EXCEPTION 'insufficient teacher experience quota for BLE authorization'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported BLE qualification type'
      USING ERRCODE = '22023';
  END IF;

  IF NOT had_reservation THEN
    UPDATE public.verification_ble_qualifications AS target
       SET units_reserved_at = CLOCK_TIMESTAMP(),
           updated_at = CLOCK_TIMESTAMP()
     WHERE target.id = qualification.id
       AND target.units_reserved_at IS NULL;
  END IF;

  RETURN QUERY SELECT
    qualification.verification_type::TEXT,
    qualification.unit_count,
    current_available,
    other_reserved,
    current_available - other_reserved - qualification.unit_count,
    NOT had_reservation;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_verification_ble_units(BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_verification_ble_units(BIGINT)
  TO service_role;

COMMENT ON COLUMN public.verification_ble_qualifications.units_reserved_at IS
  'Migration 072: qualification-scoped unit reservation created atomically before BLE authorization; expires with the 90-second qualification and is idempotent for same-qualification rescans.';
COMMENT ON FUNCTION public.reserve_verification_ble_units(BIGINT) IS
  'Migration 072: locks a NORMAL customer/product or EXPERIENCE teacher/product bucket, subtracts other live reservations, and fails closed before BLE authorization when units are insufficient.';

COMMIT;

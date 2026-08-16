BEGIN;

-- A browser retry or double click must return the same recharge order instead
-- of creating a second order. This key contains no customer-sensitive data.
ALTER TABLE public.recharge_records
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recharge_idempotency_key
  ON public.recharge_records (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Migration 021 derives balances from APPROVED orders. Remove the legacy
-- incremental triggers from migration 009 so an approval cannot be counted by
-- both mechanisms. Pending and rejected orders remain excluded by
-- refresh_customer_balance().
DO $$
BEGIN
  IF TO_REGPROCEDURE('public.refresh_customer_balance(bigint)') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_trigger
       WHERE tgrelid = 'public.recharge_records'::regclass
         AND tgname = 'trg_recharge_refresh_customer_balance'
         AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'Migration 021 must be applied before migration 023.';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_recharge_balance
ON public.recharge_records;

DROP TRIGGER IF EXISTS trg_apply_verification_balance
ON public.verification_records;

COMMIT;

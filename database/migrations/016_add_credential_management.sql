-- Add secure credential-management metadata to an existing rebuilt database.
-- This migration is self-contained: it also creates the minimal HQ helper
-- required by its RLS policy. It never stores a password value or password hash.

BEGIN;

ALTER TABLE public.staff_accounts
  ADD COLUMN IF NOT EXISTS password_initialized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_change_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.credential_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_staff_account_id BIGINT NOT NULL REFERENCES public.staff_accounts(id),
  actor_staff_account_id BIGINT REFERENCES public.staff_accounts(id),
  event_type VARCHAR(32) NOT NULL
    CHECK (event_type IN ('ACCOUNT_CREATED', 'HQ_PASSWORD_RESET', 'SELF_PASSWORD_CHANGED')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credential_events_target_time
  ON public.credential_events (target_staff_account_id, occurred_at DESC);

ALTER TABLE public.credential_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_hq()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_accounts
    WHERE auth_uid = auth.uid()::TEXT
      AND role_code = 'hq'
      AND account_status = 'ACTIVE'
  );
$$;

DROP POLICY IF EXISTS credential_events_hq_read ON public.credential_events;
CREATE POLICY credential_events_hq_read
ON public.credential_events
FOR SELECT TO authenticated
USING (public.is_hq());

COMMIT;

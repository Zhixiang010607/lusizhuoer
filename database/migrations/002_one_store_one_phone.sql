-- Store account rule: a store may have only one active login account at any time.
-- staff_accounts.phone is already unique, so one phone number can belong to one identity only.
-- Run this migration once in the CloudBase SQL editor.

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_store_account_per_store
  ON public.staff_store_assignments (store_id)
  WHERE assignment_status = 'ACTIVE';

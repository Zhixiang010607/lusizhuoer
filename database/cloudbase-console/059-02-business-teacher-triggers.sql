-- Migration 059, step 2: install the business-teacher INSERT triggers.
BEGIN;

DO $$
BEGIN
  IF TO_REGPROCEDURE('public.enforce_business_teacher_matrix_v59()') IS NULL
     OR TO_REGPROCEDURE('public.enforce_current_recharge_integrity()') IS NULL
     OR TO_REGPROCEDURE('public.enforce_current_verification_integrity()') IS NULL THEN
    RAISE EXCEPTION 'migration 059 functions are missing; execute step 059-01 after migrations through 058';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger trigger
     WHERE trigger.tgrelid = 'public.recharge_records'::regclass
       AND trigger.tgname = 'trg_058_recharge_integrity'
       AND trigger.tgfoid = 'public.enforce_current_recharge_integrity()'::regprocedure
       AND NOT trigger.tgisinternal AND trigger.tgenabled <> 'D'
       AND (trigger.tgtype & 1) = 1 AND (trigger.tgtype & 2) = 2
       AND (trigger.tgtype & 4) = 4 AND (trigger.tgtype & 16) = 16
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger trigger
     WHERE trigger.tgrelid = 'public.verification_records'::regclass
       AND trigger.tgname = 'trg_058_verification_integrity'
       AND trigger.tgfoid = 'public.enforce_current_verification_integrity()'::regprocedure
       AND NOT trigger.tgisinternal AND trigger.tgenabled <> 'D'
       AND (trigger.tgtype & 1) = 1 AND (trigger.tgtype & 2) = 2
       AND (trigger.tgtype & 4) = 4 AND (trigger.tgtype & 16) = 16
  ) THEN
    RAISE EXCEPTION 'migration 059 requires enabled migration 058 BEFORE INSERT OR UPDATE row triggers';
  END IF;
END;
$$;

LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_059_recharge_business_teacher ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_059_verification_business_teacher ON public.verification_records;

CREATE TRIGGER trg_059_recharge_business_teacher
BEFORE INSERT ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_business_teacher_matrix_v59();

CREATE TRIGGER trg_059_verification_business_teacher
BEFORE INSERT ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_business_teacher_matrix_v59();

COMMIT;

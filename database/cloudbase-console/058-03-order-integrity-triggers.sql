BEGIN;
LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS trg_recharge_guard_balance_fields ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_recharge_guard_status_transition ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_verification_guard_balance_fields ON public.verification_records;
DROP TRIGGER IF EXISTS trg_verification_guard_status_transition ON public.verification_records;
DROP TRIGGER IF EXISTS trg_validate_verification_status_transition ON public.verification_records;
DROP TRIGGER IF EXISTS trg_058_recharge_integrity ON public.recharge_records;
DROP TRIGGER IF EXISTS trg_058_verification_integrity ON public.verification_records;
CREATE TRIGGER trg_058_recharge_integrity BEFORE INSERT OR UPDATE ON public.recharge_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_current_recharge_integrity();
CREATE TRIGGER trg_058_verification_integrity BEFORE INSERT OR UPDATE ON public.verification_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_current_verification_integrity();
COMMIT;

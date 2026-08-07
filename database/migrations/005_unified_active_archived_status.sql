-- 所有主数据仅使用 ACTIVE（活跃）和 ARCHIVED（封存）两种业务状态。
-- CloudBase 身份认证的 BLOCKED 仅是认证层禁用标志，不是业务状态值。
UPDATE public.staff_accounts SET account_status = 'ARCHIVED' WHERE account_status = 'BLOCKED';

ALTER TABLE public.staff_accounts
  DROP CONSTRAINT IF EXISTS staff_accounts_account_status_check;
ALTER TABLE public.staff_accounts
  ADD CONSTRAINT staff_accounts_account_status_check
  CHECK (account_status IN ('ACTIVE', 'ARCHIVED'));

-- 老师资料封存时，同步封存其登录账号；反之恢复为活跃。
CREATE OR REPLACE FUNCTION public.sync_teacher_account_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.staff_account_id IS NOT NULL THEN
    UPDATE public.staff_accounts
    SET account_status = CASE WHEN NEW.teacher_status = 'ARCHIVED' THEN 'ARCHIVED' ELSE 'ACTIVE' END,
        updated_at = NOW()
    WHERE id = NEW.staff_account_id
      AND account_status IS DISTINCT FROM CASE WHEN NEW.teacher_status = 'ARCHIVED' THEN 'ARCHIVED' ELSE 'ACTIVE' END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_teacher_account_status ON public.teachers;
CREATE TRIGGER trg_sync_teacher_account_status
AFTER INSERT OR UPDATE OF teacher_status, staff_account_id ON public.teachers
FOR EACH ROW EXECUTE FUNCTION public.sync_teacher_account_status();

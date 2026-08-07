-- 门店账号约束：每个门店在任意时刻只能有一个有效的门店登录账号。
-- staff_accounts.phone 本身已有 UNIQUE 约束，因此一个手机号也只能属于一个身份。
-- 请在 CloudBase「SQL 型数据库 → SQL 编辑器」执行一次。

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_store_account_per_store
  ON public.staff_store_assignments (store_id)
  WHERE assignment_status = 'ACTIVE';

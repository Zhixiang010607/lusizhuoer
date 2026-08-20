# 048：CloudBase SQL 编辑器 4KB 安全执行包

这个目录解决 CloudBase SQL 编辑器把较长的 PL/pgSQL 函数截断、继而报
`unterminated dollar-quoted string` 的问题。每个 `.sql` 文件都是一个完整的
`BEGIN; ... COMMIT;` 事务，单独粘贴、单独执行；任何一个函数的 `$$` 开始和
结束都在同一个文件中。

本包只适用于根目录的
[`../048-01-quota-lifecycle-schema.sql`](../048-01-quota-lifecycle-schema.sql)
已经显示 **COMMIT 成功** 的环境。它不修改 048 的正式 migration，也不应与原
`048-02` 至 `048-07` 文件混合执行。

## 先清掉报错事务

如果当前 SQL 编辑器刚报了 `unterminated dollar-quoted string`，新建一个查询，
只执行下面这一句并确认成功；不要和任何迁移文件一起执行：

```sql
ROLLBACK;
```

该错误表示那次不完整的 `CREATE OR REPLACE FUNCTION` 没有提交。已经确认
`COMMIT` 成功的短文件可以保留，无须回滚数据库历史。

## 正常顺序（048-01 已成功，但 048-02 尚未确认）

清空编辑器后，每次只粘贴一个文件，`Ctrl+A` 选中整个文件执行。必须看到该文件
的 `COMMIT` 成功，才继续下一项：

1. `01-sync-teacher-profile.sql`
2. `02-sync-teacher-account-status.sql`
3. `03-active-experience-subjects.sql`
4. `04-quota-resettable.sql`
5. `05-reset-single-quota.sql`
6. `06-reset-all-quotas.sql`
7. `07-configure-quota.sql`
8. `08-remove-quota.sql`
9. `09-01-validate-recharge-request.sql`
10. `09-02-recharge-active-quota.sql`
11. `10-active-order-master-data.sql`
12. `11-lock-active-verification-subjects.sql`
13. `12-usage-guard.sql`
14. `13-permissions-and-comments.sql`
15. `14-verify-fallback.sql`（只读验收；结果必须全部为 `READY`）

## 当前现场：048-02 和 048-03 已成功、048-04 报截断

不要重跑已经成功的 `048-02`／`048-03`。在单独执行过 `ROLLBACK;` 后，按下面的
短顺序继续即可：

1. `09-01-validate-recharge-request.sql`
2. `09-02-recharge-active-quota.sql`
3. `10-active-order-master-data.sql`
4. `11-lock-active-verification-subjects.sql`
5. `12-usage-guard.sql`
6. `13-permissions-and-comments.sql`
7. `14-verify-fallback.sql`

`09-01` 是只供 `09-02` 使用的输入校验／备注规范化助手；`09-02` 保留原来的
`public.recharge_teacher_product_experience_quota(...)` 函数签名、幂等规则、余额
更新和审计流水。第 13 段会收紧该内部助手及所有 048 函数的 `PUBLIC` 权限。

## 保留的业务行为

- 老师是否激活只看老师和账号状态；没有老师人脸也能激活、登录和办理。
- 配置产品额度会立即把当前可用次数改成新的月额度；删除配置只封存额度，不删除
  充值、月度重置、体验核销或配置历史。
- 独立充值只允许活跃老师、活跃产品和活跃额度配置，并保留原有幂等键校验。
- 每月重置只处理活跃老师、活跃产品和活跃额度配置。
- 新订单、体验核销和直接写入体验用量都拒绝已封存的门店、老师、产品或客户；老师
  人脸不是这些判断条件。客户人脸资料仍是核销的独立要求。

`14-verify-fallback.sql` 若出现任何 `MISSING`，不要发布依赖 048 的云函数或前端；
先停止并保存查询结果以便排查。

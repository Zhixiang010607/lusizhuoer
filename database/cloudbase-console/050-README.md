# Migration 050 部署顺序

050 只做向前修复，不要修改或重跑已上线的 046—049。它会：

- 补齐压力数据／历史数据中只有 `staff_accounts` 而没有 `teachers` 的老师主档；
- 修复历史／压力老师主档，并确认已有老师的激活或封存状态不受人脸字段影响（新建老师仍必须当次完成人脸）；
- 修复老师体验额度单独充值的 `SQLSTATE 42702 manual_recharge_count is ambiguous`；
- 拒绝通过陈旧 API 删除已封存老师或已封存产品的额度配置。

在 CloudBase SQL 编辑器中依次、每次只执行一个文件：

1. `050-01-prerequisites.sql`
2. `050-02-sync-teacher-profile.sql`
3. `050-03-sync-teacher-account-status.sql`
4. `050-04-backfill-teacher-profiles.sql`
5. `050-05-delete-active-quota.sql`
6. `050-06-recharge-qualified.sql`
7. `050-07-permissions-comments.sql`
8. `050-readonly-verify.sql`（只读）

前 7 段都是独立的 `BEGIN/COMMIT` 事务，按 Windows CRLF 计算也都小于 3,500 字节。任意一段失败时停止，不要继续下一段；如编辑器处于 aborted transaction，先单独执行 `ROLLBACK;`，再重跑当前段。

最后的只读验收应返回 7 行且全部为 `READY`。然后才部署配套的 `faceRecognition v73` 和 `staffAccount v57`。

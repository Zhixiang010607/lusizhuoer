# Migration 059

本迁移把最新业务老师矩阵固化在数据库写入边界：

- 门店充值／退费的业务老师可选；
- 门店正常核销必须选择活跃业务老师；
- 门店不能提交体验核销；
- 老师账号提交的业务只能归属当前老师本人；
- 总部和已退役角色不能创建业务工单。

按顺序整文件执行：

1. `059-preflight-store-binding-layout.sql`（只读）；
2. `059-preflight-business-teacher-attribution.sql`（只读）；
3. 确认第一个预检中的 `selected store binding layout` 为 `READY_CURRENT` 或 `READY_LEGACY`，并复核历史预检中所有非 `READY`／`EMPTY` 的计数；
4. 确认历史门店单据中已有的 `teacher_id` 确实代表当时选择的业务老师；
5. `059-00-store-binding-prerequisites.sql`；
6. `059-01-business-teacher-function.sql`；
7. `059-02-business-teacher-triggers.sql`；
8. `059-readonly-verify-store-binding.sql`（只读）；
9. `059-readonly-verify.sql`（只读）。

当前重建结构优先使用 `stores.store_account_id`，并同时要求门店为 `ACTIVE`；只有该列不存在时才兼容旧 `staff_store_assignments`，且同时要求绑定与门店均为 `ACTIVE`。当前结构不依赖旧绑定表。

所有 059 控制台 SQL 都小于 3.5 KB，即使换行格式变化仍为 CloudBase SQL 编辑器保留截断余量。最后两个验证文件的每一行都必须为 `READY`。迁移不会回填或删除历史记录，也不会把业务归属变成写权限：
补照片、修改、恢复和防重仍只认原 `submitted_by_account_id`。

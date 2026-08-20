# Migration 052 部署顺序

052 在 051 的老师人脸操作租约中增加 CloudBase Auth `createUser` 成功回执。
`auth_uid` 仍是创建前预绑定的确定性 UID；新增的 `auth_create_returned_uid`
记录平台实际返回的 UID，`auth_create_confirmed_at` 记录该回执被当前
owner/generation 租约持久化的时间。这使正常成功可直接继续，同时保留云函数
中断后的可审计清理依据。两列必须同时为空或同时有值；有值时还必须是
已绑定 `auth_uid` 和所有权摘要的 `PROVISION` 操作。因此 051 历史操作保持两列为空，
不会被伪造成已收到创建回执。

在 CloudBase PostgreSQL SQL 编辑器中，依次、每次只执行一个文件：

1. `052-01-auth-create-receipt.sql`
2. `052-readonly-verify.sql`（只读）

第 1 段是独立 `BEGIN/COMMIT` 事务，可安全重试；它不修改老师、人脸、
照片、登录账号或业务流水。任一段失败即停止；如当前查询已进入
aborted transaction，先在另一查询单独执行 `ROLLBACK;`，再重跑失败段。
只读验收应返回 5 行并全部显示 `READY`。

必须先完成 051 及其只读验收，再执行 052；052 验收通过后才部署
`staffAccount v63`。v63 严格采用门店／客户创建的快速成功口径：平台返回的精确
`Data.Uid` 与预绑定 UID 一致时持久保存本迁移提供的回执并立即继续；只有响应
无法确认时才短时读回，并由前端用原 `clientRequestId` 和完整原负载自动恢复同一
请求，不生成第二个账号，也不进入新的前台 90 秒等待。90 秒栅栏仅保留给
v59—v62 历史 `CLEANUP_PENDING` 墓碑的兼容清理。不要先发布依赖这两个回执列的云函数。

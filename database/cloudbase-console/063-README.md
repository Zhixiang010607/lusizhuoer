# 063 数据库客户端直连封锁与正常核销余额保护

这是安全修复，不删除或改写任何业务数据。当前网页和小程序只允许调用
CloudBase 云函数；`anon` 和 `authenticated` 不再直接读取或修改 PostgreSQL
业务表，也不能直接执行审核、核销或设备信号函数。

请在 CloudBase SQL 编辑器中依次整文件执行：

1. [`063-01-existing-object-lockdown.sql`](063-01-existing-object-lockdown.sql)
2. [`063-02-default-privilege-lockdown.sql`](063-02-default-privilege-lockdown.sql)
3. [`063-03-paid-verification-balance-guard.sql`](063-03-paid-verification-balance-guard.sql)
4. 只读执行 [`063-readonly-verify-01-access.sql`](063-readonly-verify-01-access.sql)
5. 只读执行 [`063-readonly-verify-02-defaults-and-balance.sql`](063-readonly-verify-02-defaults-and-balance.sql)

第 1 步是最高优先级的应急封锁。三个写入文件各自独立提交，所以第 2 步的旧版
即使报 `permission denied to change default privileges`，也不会回滚已经成功的
第 1 步。不要撤销第 1 步；新建 SQL 查询并执行仓库最新的第 2 步即可。如果新
查询仍提示当前事务已中止，先单独执行 `ROLLBACK;`，再重新整文件执行第 2 步。

最新版第 2 步强制封锁当前 SQL 迁移账号的未来对象默认权限，并尽力修复该账号
可以管理的其他对象所有者。腾讯云平台自有角色可能不允许当前数据库“管理员”
修改；脚本会显示 `NOTICE` 并安全跳过，而不会再导致事务失败。此类平台默认权限
仍由第 1 步撤销 `public` schema 使用权统一隔离，客户端即使看到对象级历史授权
也不能访问对象。后续每轮数据库迁移结束后必须重跑第 1、2 步及两份只读验收。

第 3 步给 `NORMAL`／历史 `SUPPLEMENT` 的生效写入增加客户行锁和数据库余额
重算。余额不足时数据库以 `SQLSTATE 23514` 和 `insufficient purchased units`
拒绝整个事务，因此不会生成核销、照片关系或设备信号。`EXPERIENCE` 仍只扣老师
体验额度，不进入客户购买余额。

两份只读验收各返回 4 行，合计 8 行；`record_count` 全部为 `0` 且 `status`
全部为 `READY`。其中默认权限项验证当前迁移账号，现有对象项验证 schema、表、
序列和函数的最终隔离。所有五份控制台 SQL 都控制在 4KB 以下，必须逐份整文件
执行。执行 063 后如果以后又用旧迁移创建了对象，应安全重跑 063-01、063-02 和
只读验收，确认旧脚本没有重新授予客户端直连权限。

如果第一份验收只有 `client function execution closed` 不是 `READY`，不要猜测
或直接修改函数所有者。只读执行
[`063-readonly-diagnose-function-access.sql`](063-readonly-diagnose-function-access.sql)，
保留其 `routine_signature`、`routine_type`、`owner_role` 和 `grant_sources` 结果，
再按实际授权来源生成最小撤权修复。schema 验收为 `READY` 时这些残留例程当前
不能被客户端调用，但在诊断完成前仍不得把整体验收标记为通过。

CloudBase 当前会在 `public` schema 中保留平台所有者
`tencentdb_cloudbase_root` 的 `guard_system_tables()` 和
`guard_system_tables_on_drop()`。当前数据库管理员无权撤销它们的默认 `PUBLIC`
执行 ACL；它们是腾讯云系统表 DDL 保护例程，不是业务函数。第一份验收仅在
`anon`／`authenticated` 同时拥有 schema 使用权时把这两个例程判为可调用；
其他任何 public 例程只要客户端仍有执行 ACL，仍会直接判为 `UNSAFE`。因此这项
例外必须和 `client schema access closed = READY` 同时成立，不能单独放行。

本次没有修改任何云函数源码，因此不产生新的云函数 ZIP，也不需要改变当前云
函数公开版本。SQL 执行完成后仍应分别用总部、门店、老师真实账号验证登录、查询、
充值提交／审核、余额充足和不足核销、人脸失败、设备信号不生成等场景。

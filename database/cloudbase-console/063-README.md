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

第 1 步是最高优先级的应急封锁。三个写入文件各自独立提交，避免第 2 步因
CloudBase 对某个对象所有者的限制失败时，把第 1 步已经关闭的当前攻击面一起
回滚。如果第 2 步报权限错误，不要重跑或撤销第 1 步；保留完整错误信息再处理。

第 3 步给 `NORMAL`／历史 `SUPPLEMENT` 的生效写入增加客户行锁和数据库余额
重算。余额不足时数据库以 `SQLSTATE 23514` 和 `insufficient purchased units`
拒绝整个事务，因此不会生成核销、照片关系或设备信号。`EXPERIENCE` 仍只扣老师
体验额度，不进入客户购买余额。

两份只读验收各返回 4 行，合计 8 行；`record_count` 全部为 `0` 且 `status`
全部为 `READY`。所有五份控制台 SQL 都控制在 4KB 以下，必须逐份整文件执行。
执行 063 后如果以后又用旧迁移创建了对象，应安全重跑 063-01、063-02 和只读
验收，确认旧脚本没有重新授予客户端直连权限。

本次没有修改任何云函数源码，因此不产生新的云函数 ZIP，也不需要改变当前云
函数公开版本。SQL 执行完成后仍应分别用总部、门店、老师真实账号验证登录、查询、
充值提交／审核、余额充足和不足核销、人脸失败、设备信号不生成等场景。

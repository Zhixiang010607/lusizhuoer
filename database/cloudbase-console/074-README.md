# 074 总部日报追踪

按以下顺序执行：

1. 在腾讯云 CloudBase PostgreSQL 控制台完整执行 `074-01-hq-daily-report-tracking.sql`；
2. 完整执行 `074-readonly-verify.sql`；
3. 确认检查结果为 `READY`；
4. 部署 `staffAccount v84` 和当前静态网页；
5. 调用云函数的 `health`，确认版本一致。

迁移只增加日报按日期查询索引，不修改既有日报、老师或账号资料。追踪页的老师电话直接读取现有账号主档。

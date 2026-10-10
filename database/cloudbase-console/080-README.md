# 080 修复补录核销 `id` 歧义

生产执行状态（2026-10-10）：

- `080-01-fix-supplement-verification-id-ambiguity.sql` 已在环境
  `rusizhuoer-d9gbcsgym07651694` 执行成功；
- `080-readonly-verify.sql` 已执行，`supplement_qualified_identifiers` 与
  `supplement_service_role_only` 均返回 `READY`。

迁移 079 已执行的环境只需按顺序执行：

1. 完整执行 `080-01-fix-supplement-verification-id-ambiguity.sql`；
2. 执行 `080-readonly-verify.sql`，两行必须全部为 `READY`。

080 只替换迁移 079 新增的补录核销申请函数，把门店、产品和提交账号三个
`id` 条件改成明确的表别名。它不改表、不修改已有工单、不扣次数、不创建测试单，
也不改正常核销、体验核销、人脸验证、BLE 授权或设备信号流程。失败请求在报错事务中
已经整体回滚，可以在 080 验收通过后用原页面重新提交。

不需要为 080 单独重新部署云函数；当前 `faceRecognition v125` 会直接调用修复后的
数据库函数。小程序 `0.3.5` 另行上传只是补充照片压缩与回显加速，不是 080 生效的前置条件。

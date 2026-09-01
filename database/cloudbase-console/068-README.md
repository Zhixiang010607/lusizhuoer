# 068 客户评价旁路表

1. 在 CloudBase SQL 控制台完整复制并执行 `068-01-customer-work-order-ratings.sql`。该文件是独立事务，不依赖 `\i`、命令行或手工拼接。
2. 再完整执行 `068-readonly-verify.sql`，全部 9 行都必须为 `READY`。
3. 部署 `customerRating v2` 前，为该函数配置至少 32 字节的 `CUSTOMER_RATING_SIGNING_KEY`，并把实际发布后的 `rating.html` 完整 HTTPS 地址填入必需的 `CUSTOMER_RATING_BASE_URL`；两者均不得放进网页、小程序、二维码、仓库或日志。CloudBase 还必须开启匿名登录、给匿名角色增加云函数网关权限，并对 `customerRating` 使用 `"auth != null"` 调用规则；数据库权限仍保持完全关闭。v2 允许总部或工单所属门店签发评价二维码，老师仍被拒绝。
4. 本迁移只新增评价数据，不修改核销、人脸、照片、BLE、扣次或工单状态。数据库触发器会把门店和老师强制锁定为已完成的正常核销／体验核销原工单，并禁止删除或改写已提交评价。
5. 同一工单只有一份评价；公开令牌由服务端签名，数据库只保存 SHA-256 摘要，不保存明文二维码令牌。

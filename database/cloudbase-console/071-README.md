# 071 允许设备跨核销重复 nonce

本迁移只取消 `device_id + nonce` 的全局唯一限制，使简单设备即使一直返回同一个
32 位十六进制随机码，也能在不同核销资格中继续使用。它不会取消以下唯一性：

- 每个 `qualification_id` 仍只能生成一条设备授权；
- 每个 `authorization_token` 仍唯一；
- 每条授权仍只能绑定一张最终核销工单；
- 原提交幂等键、余额事务和扣次原子性保持不变。

## 执行顺序

1. 暂停新 BLE 核销写入。
2. 在腾讯 CloudBase PostgreSQL 控制台完整执行
   `071-01-allow-reused-ble-nonce.sql`。
3. 完整执行 `071-readonly-verify.sql`，确认 4 行全部为 `READY`。
4. 设备固件切换到约定的凯撒签名算法后，再部署当前 `faceRecognition v120`。
5. 调用 `{ "action": "health" }`，确认返回 `version=v120`，再恢复 BLE 核销。

迁移 071 可以先于 v118 执行；旧版 `faceRecognition v117` 在没有发生其他唯一冲突时
仍可运行。不要在设备固件尚未支持凯撒签名时提前部署 v118。

## 生产执行记录

2026-10-08 已在 `rusizhuoer` 生产环境完整执行迁移 071；随后执行只读验收，
“全局 nonce 唯一约束已移除、每资格仍仅一条授权、授权令牌仍唯一、审计索引存在”
4 行全部返回 `READY`。生产 `faceRecognition` 仍为 v117，v118 尚未部署。

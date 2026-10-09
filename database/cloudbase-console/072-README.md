# 072 BLE 授权前次数预留

本迁移修复“90 秒资格创建后、BLE 授权签发前余额可能已经变化”的安全缺口。
每次签发 `auth` 前，数据库会按正常核销的“客户+项目”或体验核销的“老师+项目”
加事务锁，扣除其他尚有效资格已经预留的次数，再判断当前次数是否足够。

- 次数不足：数据库拒绝预留，云函数不得生成、保存或返回设备授权；
- 同一资格重复扫码：复用同一份预留，不会重复占次数；
- 两笔并发资格：只有合计不超过当前可用次数的请求可以取得授权；
- 资格过期、取消或完成：旧预留自动不再参与后续可用次数计算；
- 真正扣次仍只发生在设备返回工作状态 `2` 后，并继续经过原有原子写入函数复核。

## 执行顺序

1. 暂停新的 BLE 核销写入；
2. 整文件执行 `072-01-ble-authorization-unit-reservation.sql`；
3. 整文件执行 `072-readonly-verify.sql`，确认 6 行全部为 `READY`，两项
   `overbooked` 计数和 `live authorization without reservation` 均为 `0`；
4. 上传 `deployments/faceRecognition-v122.zip` 并安装依赖；
5. 调用 `{ "action": "health" }`，确认 `version=v122` 后恢复 BLE 核销。

迁移会为执行时仍有效的旧授权补记预留。如果旧运行时已经产生余额／额度超订，迁移会
整体回滚并报告冲突分组数，不会带着不一致状态继续部署。不要先部署 v122 再执行 SQL；
v122 会检查迁移 072，结构缺失时关闭 BLE 资格和授权入口。

## 生产执行记录

2026-10-09 已在生产环境 `rusizhuoer-d9gbcsgym07651694` 执行完成：

- 迁移执行 RequestId：`364bb8fb-563d-46d5-b518-b31f7be9ac5a`；
- 只读验收 RequestId：`39f0c801-99f0-4b38-86ec-d6881f123dd3`；
- 6 行验收结果全部为 `READY`；
- `live authorization without reservation` 为 `0`；
- 正常余额与老师体验额度的 `overbooked` 计数均为 `0`；
- 随后部署的 `faceRecognition v122` 运行时健康检查通过。

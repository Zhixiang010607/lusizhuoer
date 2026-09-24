# 069：魔法柔肤 BLE 身份格式

1. 在 CloudBase PostgreSQL 控制台完整执行 [`069-01-magic-soft-skin-ble-identity.sql`](069-01-magic-soft-skin-ble-identity.sql)。该文件只放宽迁移 066 的三项格式约束，不删除或改写已有资格、授权、核销和工单数据。
2. 完整执行 [`069-readonly-verify.sql`](069-readonly-verify.sql)，确认 3 行全部为 `READY`。
3. 上传 [`faceRecognition-v114.zip`](../../deployments/faceRecognition-v114.zip)，安装依赖并调用 `health`，确认 `version=v114`。
4. 最后上传包含新 BLE 识别规则的小程序开发版，再用真机和真实设备联调。SQL、云函数、小程序三项缺一不可。

本迁移新增的魔法柔肤固定设备档案为：`device_id=LA` 加 12 位大写十六进制、`device_type=LASER-BLE`、`ble_name=LA-` 加设备编号末 6 位。二维码继续使用 `nc://bind?sn=<device_id>&code=<6位数字>`。旧的 `NCM` 设备编号及其他项目原规则继续兼容，直至相应厂家提供正式格式。

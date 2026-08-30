# 066：人脸通过后的 BLE 核销门禁

本组脚本把正常核销与体验核销拆成“人脸通过后的 90 秒资格 → 一次性设备授权 → 设备工作态回执 → 原有原子核销”。打开、关闭、重新打开扫码窗口，以及二维码、蓝牙、网络或设备错误都不会扣次；只有设备回报 `ok=true,status=2` 且服务端复核资格、设备、随机数和 30 秒授权均有效后，才调用原有核销事务。

## 执行顺序

1. 新环境在 CloudBase PostgreSQL 控制台完整执行 [`066-01-ble-verification-authorization.sql`](066-01-ble-verification-authorization.sql)。已经存在 `verification_ble_qualifications` 与 `verification_ble_authorizations` 两张表的环境不需要重跑 SQL。
2. 如果此前执行过会建立第三张 `verification_ble_devices` 的旧版 066，执行 [`066-02-retire-legacy-device-registry.sql`](066-02-retire-legacy-device-registry.sql)。脚本只删除这张已退役的注册表；表本来不存在时不做任何修改，资格、授权和核销记录不受影响。
3. 在 `faceRecognition` 云函数环境变量中配置一个随机且至少 32 字节的 `BLE_AUTH_SIGNING_KEY`，并把完全相同的值写入设备受保护的非易失安全存储。密钥不要发到聊天、不要写入仓库、小程序或二维码。
4. 不建立、不查询也不维护设备注册表、设备主档、数据库设备白名单或配对码表。设备身份由二维码序列号、实时 BLE `get_info`、一次性随机数、90／30 秒窗口和 HMAC-SHA256 共享密钥共同校验。
5. 按 [`067-README.md`](067-README.md) 在业务低峰期建立大数据充值／退费查询索引并通过只读验收。
6. 上传 `deployments/faceRecognition-v108.zip`，安装依赖并调用 `health`，确认 `version=v108`。
7. 执行 [`066-readonly-verify.sql`](066-readonly-verify.sql)，确认 11 行全部为 `READY`，其中 `BLE device registry absent` 必须为 `READY`。
8. 最后上传当前小程序并设为体验版。不要在 SQL 和云函数尚未生效时先发布前端。

## 安全边界

- `anon`、`authenticated` 和 `PUBLIC` 对两张 BLE 表没有表或序列权限；只有云函数 `service_role` 可以访问。
- 二维码六位 code 不是密钥，只在本次扫码请求内传给云函数，授权审计只保存其 SHA-256 哈希。
- 云端和设备端使用同一 HMAC-SHA256 对称共享密钥；不存在需要另行生成或填写的 public key。
- 资格有效期最长 90 秒；关闭扫码窗口不取消资格，90 秒内可重新打开。
- 单次 HMAC 授权有效期最长 30 秒，并绑定设备编号、设备类型、核销次数、签发时间、失效时间和一次性随机数。
- 扫码、连接、协议识别、授权或查询状态失败都不会写核销工单；设备工作态确认成功后二维码窗口永久关闭并跳转工单。
- V2.0 设备工作回执本身没有独立设备签名。当前服务端通过已绑定连接上下文、设备编号、类型、随机数和一次性授权降低伪造风险，但这不是密码学设备证明。固件下一版应对工作回执增加设备密钥签名或挑战应答。

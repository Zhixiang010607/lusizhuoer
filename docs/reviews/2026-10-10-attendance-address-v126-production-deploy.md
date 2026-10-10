# 考勤可读地址生产部署记录

日期：2026-10-10（Australia/Sydney）

## 数据库

- 已在生产环境 `rusizhuoer-d9gbcsgym07651694` 完整执行迁移 081。
- `081-readonly-verify.sql` 返回四项 `READY`：字段、约束、`service_role` 权限和客户端隔离全部通过。
- 迁移只给不可变考勤记录增加可空的附近地点、具体地址和地址服务字段；没有修改核销、照片、BLE、设备状态或扣次表。

## 云函数

- `faceRecognition v126`：`Active`，Node.js 18.15，超时 900 秒。
- `staffAccount v88`：`Active`，Node.js 20.19，超时 90 秒。
- 通过微信开发者工具 CloudBase CLI 分别下载线上函数，并逐文件比较 `index.js`、`package.json` 和 `README.md`；两套线上源码均与本地部署源完全一致。
- `faceRecognition-v126.zip` SHA-256：`100881b4978c1f774a7bee00ad80f24a242ffd5bcc5efdfbaf76c3a7ce3fb634`。
- `staffAccount-v88.zip` SHA-256：`ca7601925f272295e8da84bc0a6add364a39da125acbbd16b326fddf460b41e4`。

## 地图密钥状态

生产 `faceRecognition` 当前没有配置 `TENCENT_MAP_KEY` 和 `HERE_GEOCODING_API_KEY`。这是可读地址生成的唯一未完成外部配置：

- 中国境内地址优先使用腾讯地图逆地址解析；
- 堪培拉等境外地址优先使用 HERE 逆地址解析；
- 未配置密钥或服务临时失败时，打卡仍正常保存经纬度、定位精度和地图，不阻断老师上／下班打卡；
- 配置后只影响新打卡记录，旧记录不根据历史坐标批量虚构文字地址。

## 小程序

- 开发版 `0.3.14` 已由官方 CLI 上传成功。
- 主包 `1,808,310` 字节，总包 `3,459,845` 字节。
- 尚未设为体验版、提交审核或正式发布。

## 回归与边界

- 全仓 377 项测试通过。
- 正常核销、体验核销、补录核销、照片、人脸和 BLE 固定 20 字节设备路径未改动。
- 可读地址由服务端根据签名定位令牌中的真实坐标解析；客户端不能自行提交门店名或道路名。

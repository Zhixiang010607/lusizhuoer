# 081 考勤可读地址

按顺序执行：

1. 完整执行 `081-01-teacher-attendance-readable-address.sql`；
2. 执行 `081-readonly-verify.sql`，四行必须全部返回 `READY`；
3. 给 `faceRecognition` 云函数配置地图服务密钥：国内自动地点优先使用
   `TENCENT_MAP_KEY`，堪培拉等境外地址优先使用 `HERE_GEOCODING_API_KEY`；
4. 上传 `faceRecognition-v126.zip` 与 `staffAccount-v88.zip`，分别调用
   `health` 核对版本；
5. 最后上传包含地址展示的小程序。

迁移只给不可变考勤记录增加“附近地点、具体地址、解析服务”三个可空字段。
经纬度、定位精度和地图仍是权威审计信息；地址服务临时失败或未配置时，打卡继续
保留真实坐标且不会阻断。旧考勤记录不会虚构地址，仍显示经纬度与地图。

本迁移不改客户、核销、体验核销、补录核销、照片、BLE 授权、设备状态或扣次表，
也不修改考勤人脸校验和每日上／下班唯一约束。

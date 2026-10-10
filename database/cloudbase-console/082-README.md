# 迁移 082：总部重录老师考勤人脸

按顺序在腾讯云 CloudBase PostgreSQL 控制台完整执行：

1. `082-01-teacher-attendance-face-replacement.sql`
2. `082-readonly-verify.sql`

第二个文件应返回四行 `READY`。本迁移只增加考勤专用人脸档案的原子替换与不可变审计，不修改历史考勤、日报、核销、余额、BLE 或客户人脸数据。

# 090：老师只拍照打卡

状态：2026-11-01 经用户授权，已通过完整备份门禁在生产执行；40 张 public 基础表、244 行、45 个序列值备份验证通过，四项独立检查全部 READY，迁移前后全部 40 张表的数据摘要一致。备份及私有回执保留。`faceRecognition v137`、`staffAccount v98` 已部署并通过 health／下载代码校验；小程序上传状态见[本轮发布记录](../../docs/reviews/2026-11-01-photo-attendance-production-release.md)。不删除历史考勤、照片、人脸档案；不涉及客户、工单、余额、审核或 BLE。以下为执行规程，**不要重复执行已完成的 090**。

1. 取得本次生产迁移授权后，先执行 `090-preview.sql`，确认原环境及考勤记录数／照片数／历史摘要，回执私下保存。预检为单条 SELECT，所有字段连同守卫摘要一起返回，避免 CloudBase CLI 多语句只返回末条结果而遗漏历史基线。
2. 只通过完整备份门禁执行 `090-01-teacher-photo-attendance.sql`：

   ```sh
   node scripts/cloudbase-pg-change.js --env rusizhuoer-d9gbcsgym07651694 --label teacher-photo-attendance --sql database/cloudbase-console/090-01-teacher-photo-attendance.sql --apply
   ```

   必须验证全部 public 基础表行数及序列快照，失败不得直接执行 SQL。保留备份及私有回执。
3. 独立执行 `090-readonly-verify.sql`，四项全部 READY；重跑 preview，历史行数、照片数、历史摘要及 v88 照片守卫摘要必须不变。v78 守卫只有本次明确调整的内容允许变化。
4. 上传 `faceRecognition-v137.zip`、`staffAccount-v98.zip`，分别核验 health 和下载代码；再上传小程序。无新环境变量、无函数重建、无需部署其他函数或 Web。
5. 经授权用真实老师验证先上班后下班、前置摄像头、照片留存、原图和时间水印。未录入考勤人脸也能打卡；历史 FACE 记录保留原分数，新 PHOTO 记录四项人脸审计字段必须为 NULL。不得用测试插入覆盖真实当天记录。

数据库旧客户端缺省 FACE，仍执行旧档案守卫，兼容迁移至新函数期间的在途请求；新函数一律由服务端指定 PHOTO，不接受客户端选择验证方式。照片元数据、3 MiB 限制、同日、顺序、唯一性与不可变守卫继续生效。照片打卡不是人脸身份验证，服务端不能证明照片确由实时相机拍摄；客户端仅开放相机，不作反代拍承诺。

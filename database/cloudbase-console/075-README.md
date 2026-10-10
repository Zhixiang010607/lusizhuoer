# 075 老师考勤

1. 在腾讯云 SQL 编辑器执行 `075-01-teacher-attendance.sql` 的完整实际 SQL 内容。
2. 执行 `075-readonly-verify.sql`，5 行必须全部为 `READY`。
3. 再部署 `teacherCreate v7`、`faceRecognition v123`、`staffAccount v84`。

老师建档照只在总部创建老师时保存；每次打卡照片只用于内存中的质量、活体和 1:1 验证，不写数据库或对象存储。

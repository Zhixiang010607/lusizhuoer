# 053 退役旧老师人脸 Saga

1. 先部署不再读写 051/052 的 `staffAccount v75`、`faceRecognition v98` 和
   `teacherCreate v6`。
2. 在 CloudBase PostgreSQL SQL 编辑器中完整执行
   `053-01-retire-legacy-teacher-face-saga.sql`。
3. 执行 `053-readonly-verify.sql`，7 行必须全部为 `RETIRED`。
4. 在 `staffAccount` 的触发器配置中删除
   `reconcile-teacher-face-operations`。保留老师体验额度的月初 Timer。

该迁移只删除 `teacher_face_operations` 及其 6 个私有函数。它不删除
`teachers`、`staff_accounts`、老师人脸引用、体验额度、工单或业务历史。

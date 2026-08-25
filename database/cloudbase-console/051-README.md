# Migration 051 部署顺序

> **已退役：** 该文件只保留历史追溯。当前版本不再执行 051；已执行的库请在部署 staffAccount v71／faceRecognition v91／teacherCreate v6 后执行 053 删除旧状态表。

051 为老师新建／补录／替换人脸增加持久操作租约、取消栅栏和可重试清理墓碑。它不修改已有老师、
人脸、照片或业务流水；控制记录只保存随机 owner token 的 SHA-256，不保存 token 原文。
每条操作还会固化当时的 `FACE_GROUP_ID` 与 `CUSTOMER_PHOTO_BUCKET_ID`；后续只读确认、回滚和
定时补偿必须使用租约里的原值，不能被以后环境变量改动重定向。

在 CloudBase SQL 编辑器中依次、每次只执行一个文件：

1. `051-01-prerequisites.sql`
2. `051-02-operation-table.sql`
3. `051-03-operation-indexes.sql`
4. `051-04-input-guard.sql`
5. `051-05-acquire-operation.sql`
6. `051-06-bind-operation.sql`
7. `051-07-transition-operation.sql`
8. `051-08-bind-face-id.sql`
9. `051-09-takeover-cleanup.sql`
10. `051-10-permissions-comments.sql`
11. `051-readonly-verify.sql`（只读）

前 10 段都是独立 `BEGIN/COMMIT`，按 Windows CRLF 计算均小于 3,500 字节。任一段失败即停止；
如当前查询已进入 aborted transaction，先在另一查询单独执行 `ROLLBACK;`，再重跑失败段。
只读验收必须全部显示 `READY`，尤其是 `expired owner cannot transition`。

验收通过后，继续执行并验收迁移 052，然后才部署 `faceRecognition v75` 和
`staffAccount v63`。CloudBase 函数超时必须分别设为
90 秒（不可更高）和 600 秒，并在 `staffAccount` 创建两个无业务参数 Timer：

```json
{
  "triggers": [
    {
      "name": "reset-teacher-experience-quotas-monthly",
      "type": "timer",
      "config": "0 0 0 1 * * *",
      "enable": true
    },
    {
      "name": "reconcile-teacher-face-operations",
      "type": "timer",
      "config": "0 * * * * * *",
      "enable": true
    }
  ]
}
```

控制台时区选择 `Asia/Shanghai`。第二个 Timer 每 1 分钟最多接管 5 条已过期且未清理完成的操作；
单条失败仍保留 `CLEANUP_PENDING`，下一轮继续。不要在 Timer JSON 中写 `action`、token、
operationId 或任何密钥。v63 不改变该 Timer 的名称或 Cron；现有配置已是
`reconcile-teacher-face-operations`／`0 * * * * * *` 时无需修改，只有仍使用旧 5 分钟
Cron `0 */5 * * * * *` 时才更新。总部也可用
`reconcileTeacherFaceOperation({ operationId })` 手工处理一条已过期操作，但不能提前接管有效租约。

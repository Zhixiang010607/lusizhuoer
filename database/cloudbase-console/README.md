# 腾讯云 CloudBase SQL 编辑器执行说明

`ExecutePGSql` SQL 编辑器不适合一次提交包含多个 PL/pgSQL 函数的长迁移。完整的 `037`--`047` 文件保留给正式 migration 工具；在腾讯云控制台中请改用本目录的短文件。

如果控制台此前已经出现红色事务错误，先新建一次独立查询，仅执行：

```sql
ROLLBACK;
```

然后每次清空编辑器，只粘贴一个文件，按 `Ctrl+A` 选中整个短文件后执行。看到该文件 `COMMIT` 成功后再继续：

1. `037-01-photo-schema-and-guard.sql`
2. `037-02-create-verification-function.sql`
3. `037-03-extra-photo-function.sql`
4. `038-01-five-slot-schema-upgrade.sql`
5. `038-02-create-verification-function.sql`
6. `038-03-extra-photo-function.sql`
7. `038-04-verify-photo-migrations.sql`（只读验收）
8. `039-01-direct-upload-schema.sql`
9. `039-02-begin-upload-function.sql`
10. `039-03-commit-upload-function.sql`
11. `039-04-cancel-upload-function.sql`
12. `039-05-verify-direct-upload.sql`（只读验收）
13. `040-01-fix-verification-photo-commit-ambiguity.sql`（修复补充照片提交时 `photo_slot` 歧义）

如果 039 已经执行成功、但补充照片上传报 `column reference "photo_slot" is ambiguous (SQLSTATE 42702)`，不要重跑 037--039，只需完整执行一次 `040-01-fix-verification-photo-commit-ambiguity.sql`。它仅替换原子提交函数，不改表、不删除或重写已有照片数据。

照片迁移已经完成后，如需核对 v52 当前使用的真实 PG 存储桶，可单独执行
`photo-storage-v52-readonly-check.sql`。它只读检查桶 ID、私有状态、单文件上限、JPEG MIME、迁移 039 表以及现有 RLS 策略，不是新 migration，不需要按编号重复执行。私有照片桶没有面向 `anon`／`authenticated` 的整桶策略是预期状态；服务端 `service_role` 会绕过 RLS，实际 Key 是否可访问由 v52 的 `health.verificationPhotoServiceRoleStorageReady` 验证。

不要把 `ROLLBACK;` 与上述文件放在同一次执行中；不要选中函数的一部分执行；已经成功提交的前一部分不要重复运行。

## `037-01` 已成功、旧版 `037-02`／`037-03` 失败时

不需要重跑 `037-01`。先新建独立查询只执行一次 `ROLLBACK;`，然后重新下载当前版本并依次执行：

1. `037-02-create-verification-function.sql`
2. `037-03-extra-photo-function.sql`
3. `038-01-five-slot-schema-upgrade.sql`
4. `038-02-create-verification-function.sql`
5. `038-03-extra-photo-function.sql`
6. `038-04-verify-photo-migrations.sql`
7. `039-01-direct-upload-schema.sql`
8. `039-02-begin-upload-function.sql`
9. `039-03-commit-upload-function.sql`
10. `039-04-cancel-upload-function.sql`
11. `039-05-verify-direct-upload.sql`
12. `040-01-fix-verification-photo-commit-ambiguity.sql`

旧版 `037-02` 的状态判断缺少 `CASE` 表达式括号，会报 `syntax error at end of input (SQLSTATE 42601)`；旧版 `037-03` 随后提示 `create_verification_with_face_photo ... does not exist` 是同一问题造成的连锁错误。当前文件已在真实 PostgreSQL 引擎中按上述顺序完整执行通过。

## 046、047 运营身份下线与 048 老师额度生命周期

对当前版本，先按编号完成所有尚未执行的迁移，并将 `046-01` 至
`046-08` 各自作为独立事务执行。**不要在此时先执行 047。** 正确的
切换顺序是：

1. 执行 `046-01-teacher-face-schema.sql` 至
   `046-08-permissions-and-comments.sql`，每个文件确认 `COMMIT` 成功；
2. 部署 `faceRecognition v69` 与 `staffAccount v55`，分别调用 `health`
   确认新版本；
3. 在仅限总部使用、已加载当前 `cloudbase-phone-auth.js` 的临时维护页面中，
   以已登录总部身份在浏览器控制台运行
   `await CloudBasePhoneAuth.retireOperationAccounts()`。必须等到返回成功、
   旧运营账号的 CloudBase 凭据已被封锁；该维护页不是最终静态发布；如有失败，先修复并安全重试；
4. 只有第 3 步成功后，依次完整执行
   `047-01-retire-operation-accounts.sql` 和
   `047-02-hq-reviewer-guard.sql`；
5. 依次完整执行 `048-01-quota-lifecycle-schema.sql` 至
   `048-07-comments.sql`，每个文件确认 `COMMIT` 成功；
6. 部署 `faceRecognition v71` 与 `staffAccount v55`，分别调用 `health`
   确认新版本；
7. 最后才部署当前静态前端并强制刷新浏览器。

047 不删除旧运营账号、审核人或业务记录：它封存相关账号、身份、角色、
权限和范围以保留历史外键与审计，并禁止重新创建、激活或复用运营身份。
第二段还把充值和补录核销审核限定为总部。不要把两个 047 文件与
`ROLLBACK;` 或其他文件粘在同一次执行中。

048 不删除老师产品额度的历史流水：`delete` 只封存当前可用配置，充值、
月度重置和体验核销历史仍保留；重新配置会立即把当前可用次数改为新值。它
也将老师人脸改为可后续补充／替换的资料，不再是老师账号活跃或业务选择的前置条件。
每月上海时间 1 日 00:00 的重置只处理活跃老师、活跃产品和活跃额度配置。

## 051 老师人脸持久 Saga 栅栏

完成 049、050 后，按 [`051-README.md`](051-README.md) 的顺序独立执行
`051-01` 至 `051-10`，最后运行只读 `051-readonly-verify.sql` 并确认全部 `READY`。
这些分片在 Windows CRLF 下均小于 3,500 字节。051 必须先于
`faceRecognition v75`／`staffAccount v59` 部署；部署时同时把函数超时分别固定为 90 秒／600 秒，
并创建每 5 分钟一次的 `reconcile-teacher-face-operations` 平台 Timer。

### 048 在当前控制台报 `unterminated dollar-quoted string`

部分 CloudBase SQL 编辑器会在约 4KB 时截断粘贴内容；这不是数据库函数语法
错误。不要反复执行被截断的原 `048-03`／`048-04` 文件。改用
[`048-4kb/README.md`](048-4kb/README.md) 的独立事务包，每个文件在 Windows
换行符下也不超过 3.5KB。

如果已经确认 `048-02` 和 `048-03` 成功、但 `048-04` 报此错误，先在新查询中
单独执行 `ROLLBACK;`，然后只按该 README 的现场恢复顺序执行 `09-01`、`09-02`、
`10`、`11`、`12`、`13` 和只读的 `14`。其中 `09-02` 会安全替换体验额度独立
充值函数；不会删除老师、客户、产品、额度或历史流水。

# 腾讯云 CloudBase SQL 编辑器执行说明

`ExecutePGSql` SQL 编辑器不适合一次提交包含多个 PL/pgSQL 函数的长迁移。完整的 `037`、`038`、`039` 文件保留给正式 migration 工具；在腾讯云控制台中请改用本目录的短文件。

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

旧版 `037-02` 的状态判断缺少 `CASE` 表达式括号，会报 `syntax error at end of input (SQLSTATE 42601)`；旧版 `037-03` 随后提示 `create_verification_with_face_photo ... does not exist` 是同一问题造成的连锁错误。当前文件已在真实 PostgreSQL 引擎中按上述顺序完整执行通过。

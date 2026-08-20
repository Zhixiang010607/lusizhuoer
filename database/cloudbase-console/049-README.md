# 049：老师体验人脸主体与额度修复

本包必须在 048 全部完成后执行。它是向前迁移，不会重跑或改写已经
执行的 046／048，也不删除老师、客户、额度或历史核销数据。

如果 SQL 编辑器刚刚报错，先新建一个查询并单独执行 `ROLLBACK;`。然后
每次只粘贴下面一个文件，完整选中，看到 `COMMIT` 成功后才继续：

1. `049-01-face-subject-schema.sql`
2. `049-02-face-subject-constraints.sql`
3. `049-03-face-subject-triggers.sql`
4. `049-04-experience-completeness-guard.sql`
5. `049-05-fix-quota-upsert.sql`
6. `049-06-fix-quota-delete.sql`
7. `049-07-lock-teacher-face.sql`
8. `049-08-consume-teacher-quota.sql`
9. `049-09-bind-teacher-photos.sql`
10. `049-10-idempotent-replay.sql`
11. `049-11-insert-experience.sql`
12. `049-12-create-experience.sql`
13. `049-13-permissions-and-comments.sql`
14. `049-readonly-verify.sql`（只读验收）

所有可执行分片在 Windows CRLF 换行下也不超过 3500 字节，每个
PL/pgSQL 函数的 `$$` 开始和结束都在同一个文件内。

## 业务结果

- 修复配置／删除老师额度时 `teacher_id is ambiguous (42702)`。
- 新体验核销仍然保留 `customer_id`，但人脸主体是老师：第 1 张是当次
  核销锁定的老师登记照快照，第 2 张是老师现场照，同时扣老师额度。
- 正常核销继续比对客户人脸并扣客户余额。
- 老师无人脸仍可激活和登录，仅在新办体验核销时明确拒绝，直到总部补录。
- 049 之前的历史体验单保留当时的 `CUSTOMER` 人脸主体标识，不伪造成老师照片。

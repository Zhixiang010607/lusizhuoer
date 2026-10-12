# 培训资料真实删除

1. 只读预览当前环境，确认仅涉及培训资料。
2. 通过 `scripts/cloudbase-pg-change.js --env <环境> --label training-delete --sql database/cloudbase-console/087-01-training-material-deletion.sql --apply` 完整备份、校验后执行迁移。
3. 执行 `087-readonly-verify.sql`，四项全部 READY 后部署 staffAccount v96，再更新 Web／小程序。

迁移不删除任何现有 PDF 或资料记录。总部二次确认的单份删除先停止阅读、再清理私有 PDF，最后精确删除记录；失败保留待清理行供重试。仅保留不含标题、文件引用、人员和正文的请求号／删除时间防重标记，避免旧上传队列重新发布已删除资料。数据库备份不含 PDF 字节，云端 PDF 删除不可恢复；历史下架资料不自动批量删除。

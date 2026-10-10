# 077 日报四栏全部必填

1. 完整执行 `077-01-daily-report-all-fields-required.sql`。
2. 执行 `077-readonly-verify.sql`，两行结果都必须为 `READY`。
3. 再部署 `staffAccount v85`，随后上传包含四栏必填提示的小程序。

迁移不会给历史空白栏伪造内容，也不会修改历史日报；它只要求迁移后的新增或当天修改必须四栏全部填写，每栏仍最多 200 字。

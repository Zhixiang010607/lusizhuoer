# Migration 060

本迁移新增与疗程项目完全隔离的简洁产品主档：

- `public.products` 继续代表可充值、核销、体验和配置凭证模板的“项目”；
- `public.retail_products` 只代表涂抹类／实物产品，只保存产品编号、名称、状态和内部审计字段；
- 产品编号由数据库自动生成为 `PDT001`、`PDT002`……；
- 产品只允许封存或重新激活，数据库触发器禁止物理删除；
- 同名产品不能重复创建，封存后应重新激活原产品；
- 状态变化写入 `retail_product_status_history`，保留操作人和时间。

请按顺序整文件复制到 CloudBase PostgreSQL 控制台执行：

1. `060-01-retail-products.sql`；
2. `060-readonly-verify.sql`（只读）。

只读验证必须返回 4 行，且每一行 `status` 都是 `READY`。本迁移不会修改、迁移或删除既有 `public.products` 项目和历史工单。

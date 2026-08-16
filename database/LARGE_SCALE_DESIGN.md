# 百万级业务数据设计约束

本项目按充值、核销和客户照片逐步达到 100 万级设计。100 万条 PostgreSQL 记录本身并不算大，真正决定速度的是查询边界、索引、分页方式和照片是否误存入数据库。

## 1. 数据放置

- PostgreSQL 只保存客户、门店、产品、工单、状态历史、次数汇总以及照片对象引用。
- 客户建档照片保存在私有 CloudBase Storage。`customers.profile_photo_file_id` 只保存私有对象引用。
- PostgreSQL 禁止保存图片二进制、Base64、临时签名 URL 或腾讯云密钥。
- 1:1 核销的现场照片默认只传给腾讯人脸接口完成本次校验，不长期留存；数据库只保存工单、人脸接口请求编号和业务结果。
- 私有照片展示时才生成短期签名 URL；数据库永远不保存签名 URL。前端和云函数可以短时缓存，但缓存到期必须重新签名。

这样即使有 100 万张照片，数据库仍只增加约 100 万个很短的对象引用，照片容量和流量由对象存储承担。

## 2. 工单读取

所有充值、核销、审核队列和状态历史接口必须遵守：

- 默认每页 50 条，服务端硬上限 100 条。
- 使用 `(submitted_at, id)` 游标分页，不使用越来越慢的深层 `OFFSET`。
- 查询必须先限定权限范围，例如门店、老师或总部，再限定状态和时间。
- 下拉框只返回编号、姓名等轻量字段；选中客户后才读取照片、备注和完整资料。
- 任何接口都不得一次返回某门店全部历史工单或全部照片 URL。

游标查询示例：

```sql
SELECT id, verification_code, customer_id, product_id, record_status, submitted_at
FROM public.verification_records
WHERE store_id = :store_id
  AND (submitted_at, id) < (:cursor_time, :cursor_id)
ORDER BY submitted_at DESC, id DESC
LIMIT 50;
```

`025_large_scale_order_indexes.sql` 已为客户历史、门店历史、老师历史、审核队列、产品统计和余额刷新建立相应索引。

## 3. 次数与并发

- `recharge_records` 和 `verification_records` 是不可替代的业务事实表。
- `customer_product_balances` 是客户与产品维度的当前汇总，客户主页和项目选择直接读此表，不能每次扫描全部工单。
- 充值只有审核通过后才进入购买次数。
- 正常核销和补录核销只有审核通过后才消耗一次；体验核销不消耗余额；作废已通过的正常或补录核销会恢复一次。
- `refresh_customer_balance()` 会锁定当前客户行。同一客户的并发审批会串行执行，不会重复消费或重复返还次数。
- 所有创建接口必须带唯一幂等键；审核和作废必须使用带状态条件的原子更新，并在同一事务中写状态历史。

## 4. 统计与扩容

- 客户主页读 `customer_product_balances`，不现场 `SUM` 百万工单。
- 产品、门店、老师的长周期报表后续应按日写入汇总表，页面读取日汇总；原始工单仅用于明细和审计。
- `BRIN(submitted_at)` 索引用于总部跨大时间范围扫描，B-tree 游标索引用于日常列表。
- 先保持单表。达到约 1000 万条、单索引明显超过内存，或 `EXPLAIN (ANALYZE, BUFFERS)` 证明时间范围查询变慢后，再按 `submitted_at` 做月度分区；不要仅因达到 100 万条就提前分区。
- 数据库应开启自动备份和时间点恢复；对象存储应配置私有访问、生命周期和容量告警。

## 5. 上线检查

1. 在业务量还小时执行 `database/migrations/025_large_scale_order_indexes.sql`。
2. 对主要查询执行 `EXPLAIN (ANALYZE, BUFFERS)`，确认使用 `*_cursor`、`*_approved_balance` 或 `*_pending_review_cursor` 索引。
3. 压测同一客户并发审批和不同客户并发审批，确认余额不为负且幂等重试只生成一张工单。
4. 确认 CloudBase Storage 为私有桶，照片字段中没有 `data:`、Base64 或永久公开 URL。
5. 监控 PostgreSQL 慢查询、连接数、缓存命中率、表膨胀，以及对象存储容量和下载流量。

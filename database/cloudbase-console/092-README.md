# 092：客户业务阶段按历史业务划分

用户已确认：全额退费不抹去历史充值。业务阶段只按历史已通过的 NEW 充值及 NORMAL／SUPPLEMENT 正常核销划分；体验、购买、赠品、退费、待审和驳回均不改变这项分类。没有历史有效充值仍为“有信息但没有充值”；有充值、无正常核销为“已充值但没有消费”；两者都有为“已充值并已有消费”。

执行顺序：

1. 运行 [092-preview.sql](092-preview.sql)，确认环境、表数量与预计阶段变化数量。
2. 使用 `scripts/cloudbase-pg-change.js` 完整备份全部 public 基础表与序列，验证无行数差异后，在同一门禁内执行 [092-01-historical-customer-business-stage.sql](092-01-historical-customer-business-stage.sql)。禁止绕过门禁直接写生产。
3. 独立执行 [092-readonly-verify.sql](092-readonly-verify.sql)，两项均须 READY；另外与备份核对所有工单、余额、次数、时间、照片及其他表未改变，customers 只允许 customer_process_status 改变。
4. 再部署 faceRecognition v141，核对运行版本与下载源码，最后更新 Web／小程序。其余函数无需因此重复部署。

迁移保留原 refresh_customer_balance 的锁、余额计算、次数及时间缓存，只替换阶段判断，并只回填客户阶段列；不重算余额、不修改工单、不增加客户端数据库权限。锁等待超过 5 秒、执行超过 60 秒或自校验失败将回滚，应先核对状态再决定重试。

本文件和源码包不表示已执行生产迁移。上线状态以独立验收报告为准。

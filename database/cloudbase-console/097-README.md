# 097 审核短信首次启用与关闭准备

**2026-11-28：097-01已通过完整新备份门禁执行，发送服务已启用；097-02关闭SQL未执行。** 094、095、096已执行，禁止重跑。staffAccount仍为v107，本次不修改或重传云函数／客户端。备份46张public表、620行、47个公共序列，manifest零计数差异；独立全表对比仅发送状态一行变化，序列值零变化。启用时间为北京时间2026-11-28 11:54:32.523885，8项后验全部READY，health为v107且reviewSmsDeliveryReady=true，原接收偏好及核心业务指纹不变，队列为空。实际执行SQL、备份及原始回执私有保留；文件首行执行状态注释随后同步，不改变实际SQL正文。

外部条件未确认前保持 `enabled=false`：

- 主agent已在控制台确认签名733011“广州露思卓儿科技”、应用1401179904及四模板2769941／2769944／2769946／2769949可用。签名待审核的旧记录仅为历史。
- 主agent已独立回读国内套餐1000条有效、1000条可用，用户本人付款并设置余量不足100条时续订1000条；本agent未代付款或变更续订。启用前再次确认余额，不能用真实任务探测余额。
- 用户明确要求审核通知“有多少就发多少”：审核应用1401179904同时取消每日数量上限和相同内容30秒1条限制。四模板固定且无变量，同类别多笔真实申请正文完全相同，保留同内容限制会误拒绝合法提醒，既有发送器不自动重发。主agent已保存取消全部数量频控，独立页面回读“还没有设置任何频率限制规则”；原小时及30秒总条数规则未启用。平台回执要求10分钟传播，主agent已实际等待至少10分钟、重新加载核实仍无规则，并明确发出“可以启用097”，随后才进行本轮新鲜预检、完整新备份及启用。不能将最初保存成功单独当作传播完成。
- 最小权限已由主agent在控制台策略关联表只读核实：LusizhuoerReviewSmsSendOnly仅allow `name/sms:SendSms`、资源`*`，绑定TCB_QcsRole，未修改权限。本agent的CAM GetRole读取403是权限不足，不是CLI认证过期；不因此新增权限。函数配置为TCB_QcsRole；官方STS只读回读CLI调用角色所属账号与主agent控制台一致，但CLI调用角色与函数执行角色不能混为一谈。
- v107、SDK及平台短期凭据已回读，两个Timer配置存在；另取得4次近期成功平台自动调用，返回`timer=true, deliveryReady=false, processed=0`、状态200，未主动调用Timer，未发送短信。health、配置或自动空跑均不证明手机送达。
- 不替总部账号开启或修改四类偏好；仅发送已有明确选择接收的类别。没有接收人时不人为建立偏好。

执行顺序（本轮1—3已完成；第4不主动造单或发送）：

1. 通过只读执行器运行 [097-preview.sql](097-preview.sql)，将汇总和指纹保存在私有目录。核对目标环境 `rusizhuoer-d9gbcsgym07651694`、单行关闭状态、应用、空队列、三个AFTER INSERT触发器、六个短信函数。记录核心业务／人员／偏好指纹、全部public表与序列计数。
2. 外部条件全部验收，频控保存后已至少等待10分钟且重新核实，并收到主agent明确“可以启用097”后，重新运行新鲜预检。通过以下门禁建立**新的完整public表／序列一致快照**，行数差异必须为0，随后执行 [097-01-enable-hq-review-sms.sql](097-01-enable-hq-review-sms.sql)。备份失败立即停止，禁止复用旧备份或直接控制台执行。

   ```sh
   node scripts/cloudbase-pg-change.js --env rusizhuoer-d9gbcsgym07651694 --label sms_first_activation --sql database/cloudbase-console/097-01-enable-hq-review-sms.sql --apply
   ```

3. 在独立请求运行 [097-readonly-verify.sql](097-readonly-verify.sql)，各项READY，再单独运行097-preview并比较第1步人员／偏好／业务指纹和函数定义。业务在此期间可能正常增长，不能把正常新增误认成误改；必须逐项解释差异。health应只从关闭变为就绪，不能据此宣称已经送达。
4. 不建立生产测试工单、不主动调用发送器。后续明确同意的真实新业务可观察队列与腾讯云回执；ACCEPTED仅代表平台受理，手机送达需独立证据。

本轮关闭态自动Timer已有4次成功实证；启用后的有界日志检查尚未返回新自动调用，只返回启用前历史，未继续轮询或手动触发。启用后平台自动调用与真实手机送达仍列为未验收，不能用health就绪替代。本轮未产生短信队列或发送记录，不等待或创建真实新工单做验收。

只读命令格式：

```sh
node scripts/cloudbase-pg-readonly.js --env rusizhuoer-d9gbcsgym07651694 --sql database/cloudbase-console/097-preview.sql
```

紧急关闭是另一条操作，**不是正常启用后的第二步**：重新预检，通过上述同一备份门禁、独立新备份执行 [097-02-disable-hq-review-sms.sql](097-02-disable-hq-review-sms.sql)，再独立执行 [097-disabled-readonly-verify.sql](097-disabled-readonly-verify.sql)。关闭只改 `enabled=false`，保留原启用时间、偏好、队列、回执和全部业务。已发出的网络请求不能追回；未发任务下一次发送前资格检查立即拒绝，物理CANCELLED状态由后续claim／start惰性写入。关闭态worker不清空队列，不能声称已删除积压。保留备份至用户验收；不把UNKNOWN改回PENDING，也不重发ACCEPTED或REJECTED。

097-01仅用于 `activated_at IS NULL` 且队列为空的首次启用，重复执行、关闭后重开或状态不符均会拒绝；未来重新启用须另写精确SQL、使用新启用时间、防止旧队列复活，经过同样的外部条件和备份门禁，不直接复用097-01。

既有行为审计：096仅AFTER INSERT，启用前旧单不回填；业务时间在启用前的新插入行也不通知；四类收件偏好创建任务及发送前都校验，关闭类别、换号、封存、已审核、24小时过期均失去资格。每个来源／类别／收件总部唯一，发送前持久SENDING、租约与一次尝试约束；UNKNOWN、ACCEPTED、REJECTED均不自动重发。每分钟最多5条串行处理是现有worker吞吐边界，不是每日数量配额；本轮不改变。

验证码通道：Web `cloudbase-phone-auth.js` 与小程序 `services/session.js` 通过CloudBase Auth `signInWithOtp`发送改密验证码；审核提醒通过官方SMS SDK明确使用应用1401179904。2026-11-28官方只读`DescribeLoginConfig`已确认`SmsVerificationConfig.Type=default`，即CloudBase内置验证码短信包，未使用1401179904；不再将两者是否共用列为未知。只调整审核应用频控，不调用ModifyLoginConfig或修改验证码通道及其防刷配置。模式含义见[官方数据结构](https://cloud.tencent.com/document/api/876/34822)，原始认证配置仅私有保存，不打印或提交密钥及其他配置。

隔离验收：`tests/verify-review-sms-activation-db.cjs /absolute/path/to/@electric-sql/pglite` 仅在本地内存PostgreSQL执行，35项通过。覆盖首次启用、无历史回填／无默认收件人、偏好和业务及序列／函数不变、错误应用／已有队列／缺失触发器／六个短信函数正文散列漂移拒绝、重复及关闭后重启拒绝、关闭保留队列并立即失去发送资格。零生产写入、零短信。

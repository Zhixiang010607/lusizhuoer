# 096 审核短信发送队列（首次关闭）

当前版本 `staffAccount v107`；096由v106引入且已执行。094、095已执行，禁止重复。

执行顺序：

1. 用 `096-preview.sql` 只读确认环境、前置列、三类业务表、偏好及新增对象不存在；保存私有汇总。
2. 经 `scripts/cloudbase-pg-change.js --env rusizhuoer-d9gbcsgym07651694 --label review_sms_outbox --sql database/cloudbase-console/096-01-hq-review-sms-outbox.sql --apply` 建立全public表／序列一致备份、计数一致后才执行096。不得绕过备份。
3. 独立执行 `096-readonly-verify.sql`，六项READY；与预检比较人员、偏好、充值、核销、产品购买行指纹，确认没有业务改写。
4. 部署并回下载核对 `staffAccount-v107.zip` 全根文件；现有其他云函数、Web和小程序不重发。保留月度额度Timer，新增 `send-hq-review-sms`，cron `0 * * * * * *`。仅平台来源、指定函数／触发器／时间及无客户端UID可执行。注意当前CLI `fn trigger create --trigger-name` 调用BatchCreateTrigger会替换整份列表，不能单独新增一项；须一次提交保留月度任务的完整两项清单，并独立回读验证两项cron。已验收的完整API请求体见 [双Timer配置](../../deployments/staffAccount-v107-timers.json)，不要用单任务命令替代。

首次安装状态必须 `enabled=false, activated_at=NULL`、outbox为空；不替任何总部开启类别，不向历史待审工单补发。服务端签名固定“广州露思卓儿科技”（原733011按腾讯云建议修改后重新待审），四类无变量模板已通过：产品2769941、充值2769944、退费2769946、补录核销2769949。现有短信应用1401179904仅作为配置，不修改验证码应用设置。启动前核对其发送频控；SCF执行角色须具备`sms:SendSms`最小权限，短期凭据由平台提供，不复制长期SecretId／SecretKey。

签名与运营商报备仍未可用时必须保持关闭。之后启用是另一笔生产写入，必须重新预检、完整备份、独立验收并保存精确SQL；不能现在执行激活或建立历史队列。还需用明确同意接收的总部账号做真实收信验收，不能把模拟回执或健康检查当作手机送达。

队列仅AFTER INSERT，按四个审核队列相同口径；每笔业务／类别／总部唯一。事务外调用腾讯云，不改审核、余额、扣次。发送前再次核对在职总部、当前类别、原手机和申请仍待审；超过24小时的提醒取消。每分钟最多串行5条，5秒网络超时。ACCEPTED仅平台受理；REJECTED为明确拒绝；UNKNOWN（网络不明、异常回执、执行中断）不得自动重发。SENDING任务先落库，防并发／重入；只恢复从未开始发送的过期CLAIMED。

私有队列含绑定手机号快照，禁止放入Git、日志或截图。匿名／普通登录角色不可读取、写入或调用worker SQL；设置接口仍由在职总部管理，不给客户端任何直接发送、任意收件号、改服务总开关或改模板的入口。

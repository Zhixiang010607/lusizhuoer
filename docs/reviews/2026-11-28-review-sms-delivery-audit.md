# 审核短信投递验收／Timer核查 · 2026-11-28

本次已使用四个获批模板各实际发送1条验收短信，**四条均提交成功、送达失败，控制台显示运营商网关异常；用户已确认四条均未收到**。当前生产版本为 **staffAccount v108**；本次验收没有执行SQL、修改接收偏好或业务数据，没有生成虚假工单。四条由腾讯云官方控制台发送，接收目标为用户指定的同一现有总部绑定号码，号码和人员标识仅私有保存。

## 四类投递结果

应用1401179904、签名733011“广州露思卓儿科技”，四个既有固定模板均已生效。

| 类别 | 模板ID | 发送（北京时间） | 回执时间 | 控制台结果 |
| --- | --- | --- | --- | --- |
| 产品 | 2769941 | 13:02:46 | 13:02:48 | 提交成功／送达失败／运营商网关异常 |
| 充值 | 2769944 | 13:03:52 | 13:03:54 | 提交成功／送达失败／运营商网关异常 |
| 退费 | 2769946 | 13:04:30 | 13:04:32 | 提交成功／送达失败／运营商网关异常 |
| 补录核销 | 2769949 | 13:05:02 | 13:05:04 | 提交成功／送达失败／运营商网关异常 |

直接模板验收不经过业务入队和Timer，只验证模板／签名／平台与运营商投递，不代表四类真实业务端到端通过。四条投递均未通过；用户已确认4/4未收到，与官方失败回执一致。精确运营商StatusCode及SerialNo正在使用主账号官方API Explorer的DescribeSendRecordList只读核对，目前停在腾讯云本人身份验证；不为此扩大CLI或执行角色权限，不使用可能消费状态队列的Pull接口，不盲重发。

## 已有真实业务链路

启用后已有两笔真实NEW充值通过原业务触发器入队，由既有worker各尝试一次并获腾讯云ACCEPTED/Ok；不能继续描述为“启用后尚无自动调用或发送”。两条源记录保持待审，没有为了测试修改旧业务。

独立控制台CSV记录的提交时间分别为北京时间12:37:05、12:57:04，回执分别12:37:08、12:57:06，均为送达失败、运营商网关异常。时间、充值模板和绑定接收目标与队列匹配，SerialNo逐字关联待官方只读记录核对。加上四条模板直接验收，已知六条官方回执均失败。ACCEPTED只表示腾讯云受理，不能当作手机收到。

截至12:57的只读快照，三个在职总部中一个开启接收，产品、充值开启，退费、补录核销关闭；两条充值是本轮可观察到的新真实业务覆盖，产品、退费、补录核销没有可计入四类验收的新真实源。所有源ID、队列ID、流水和原始数据私有保存。

## Timer核查

一次现行tcb.SearchClsLog查询覆盖北京时间11:56:51—12:56:51，精确限定环境rusizhuoer-d9gbcsgym07651694和staffAccount；返回100条记录、ListOver=false，没有追加分页或循环。按平台request_id去重，有六个失败请求：12:51:01.886、12:52:00.588、12:53:00.671、12:54:01.224、12:55:00.862、12:56:01.993。平台request_source均为TRIGGER_TIMER，返回FORBIDDEN，消息精确对应共享requireTeacherExperienceTimerControlPlaneCaller的非空UID否决。HTTP 200只是函数封装响应，不是业务授权成功。

ListTriggers只读回执确认：短信每分钟Timer与月度额度Timer均Enable=1、Available、指向$LATEST，最近修改仍为2026-11-08。成功历史日志也有TRIGGER_TIMER标记，且日志user_id／caller与失败记录有交集；这些元数据不等于SDK Auth UID。原始触发事件、event.Time和该次可信context没有被旧代码记录，**不能仅凭来源标记认定六条都是自然调度事件，也不能排除诊断或伪造请求被正确拒绝**。具体身份来源仍未知；保留现有所有来源校验和非空UID否决。

安装的node-sdk 3.18.3中，Auth.getUserInfo每次调用CloudBase.getCloudbaseContext读取运行时来源；当前代码不向该方法传入context。同一实际Auth对象本地三次检查中，UID随运行时字段改变，没有网络或生产操作，证明缓存auth对象本身不等于缓存UID。静态函数配置未设置相关平台身份来源字段。平台注入、运行时字段或请求归属的具体原因仍待证据，不以猜测修改鉴权。

## v108身份诊断

v108只增加诊断，不修改任何允许／拒绝决定，已于北京时间13:15:05完成官方DevTools明确路径原地部署。

- 新增cloudfunctions/staffAccount/timer-guard-diagnostics.js，仅输出布尔值、null及固定枚举／固定版本标记。
- review-sms-sender.js通过原Timer来源、函数、触发器和事件时间校验后，把当次event/context传入原控制面鉴权回调；index.js仍用同一次原SDK身份读取作非空UID否决。
- 每次对照SDK身份是否可读／UID是否存在、process.env身份字段是否存在、当次context身份字段是否存在及来源／函数／环境是否匹配。context格式仅记json、legacy、absent或invalid；事件时间只记有效性与是否在两分钟内，不记录正文或原值。
- 不打印UID、手机号、工单、事件正文、context/env原文、任意action值、请求ID、凭据或令牌；日志异常不得改变原鉴权结果。不增加测试发送入口，不改正常账号权限、SQL、偏好、Timer设置、月度额度或发送状态机。
- 源码、运行时、package、README、版本合同和staffAccount-v108.zip须一致；上传时保留两个既有Timer和原运行配置。后续只观察自然调用，不手动调用Timer。

专项检查覆盖非空UID拒绝、身份读取失败、诊断异常、伪造来源、空队列成功、context只观察不授权及日志隐私边界；18项短信／身份专项、857项完整回归和版本合同通过，九个根文件与ZIP逐字一致。官方模板直接投递、隔离触发器覆盖与生产真实业务端到端三者分别记录，不混为同一验收结论。

## 待完成的验收

1. 对六条官方流水核对StatusCode、Status、UserReceiveTime；四条模板验收已由用户确认均未收到，两条真实充值的手机实证单独记录，失败不得自动重发。
2. 本次已取得两次自然Timer存在性诊断和成功空跑；历史FORBIDDEN事件的实际身份来源仍未知，若再现再按当次证据评估，不猜测性放宽校验。
3. 四类真实端到端分别需要：新真实源提交与原INSERT触发器、唯一outbox、自然可信Timer、匹配服务商流水、成功送达回执和用户手机收到。当前不能宣称四类通过。
4. 不生成虚假财务源，不绕过产品禁止删除、余额物化或状态历史；业务不足时保留模板投递与隔离触发器的独立验收结果。

## v108部署验收

官方DevTools以明确的staffAccount函数路径原地部署，30.41秒返回成功，无超时或重传。独立health返回v108、reviewSmsDeliveryReady=true，SDK及短期凭据可用；独立回下载九个根文件与本地和ZIP逐字一致。Nodejs20.19、index.main、90秒、1024MB、执行角色、完整环境变量及网络等保护配置均与部署前相同。短信与月度额度两个Timer的Enable、AvailableStatus、$LATEST、cron及最近修改时间全部一致，没有覆盖触发器配置。

857项完整回归和版本合同通过；ZIP为deployments/staffAccount-v108.zip，九个根文件，119485字节，SHA-256为9a47a97c3155ac83dadec9ab990d4dfc5ebca91cc8cc880a1600fa2cf0fd5fd1。打包后根文件保持冻结，实际部署事实仅写本报告与PROJECT_CONTEXT，不为文档改动重传。工程本地配置指纹与部署前一致，无SQL、业务、偏好或权限变更，无手动Timer及测试短信调用。

一次现代SearchClsLog查询覆盖北京时间13:15:05—13:17:58，返回59条记录、ListOver=true，无追加查询或手动调用。按平台request_id合并console.info的分行输出，取得两次自然Timer的完整白名单诊断及成功返回：

| 北京时间 | 平台来源 | SDK UID存在 | 运行时UID存在 | context UID字段 | 决策 | 返回 |
| --- | --- | --- | --- | --- | --- | --- |
| 13:16:01.647 | TRIGGER_TIMER | false | false | 未提供（null） | allowed | timer=true、deliveryReady=true、processed=0 |
| 13:17:00.859 | TRIGGER_TIMER | false | false | 未提供（null） | allowed | timer=true、deliveryReady=true、processed=0 |

两次诊断版本均v108，SDK身份读取成功，runtimeSourceTimer、runtimeFunctionMatches、contextFunctionMatches、contextNamespaceMatches、contextSourceTimer均true；context格式为json，eventHasAction=false、eventTimeValid=true、eventTimeWithinTwoMinutes=true。runtimeKeysDeclareUid=false、contextKeysDeclareUid=null。null表示当前context没有该字段，不能冒充“字段存在但为空”。accepted／rejected／unknown均0，未发送短信。

这证明本次两次自然调用正常通过原鉴权；不能据此追溯历史六次FORBIDDEN的UID来源，历史来源仍未知，未更改允许／拒绝决策。观察达到两次即结束，不等待更多任务。原始回执私有保留；[部署验证汇总](../../deployments/2026-11-28-staff-account-v108-verification.json)记录冻结文件散列、配置比对和脱敏诊断。

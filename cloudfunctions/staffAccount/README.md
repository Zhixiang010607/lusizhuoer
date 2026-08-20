# staffAccount 云函数

当前版本：`v49`

用于总部自动创建运营、门店和老师账号；云函数使用当前登录总部账号进行授权。
`provisionStaff` 只可创建运营或门店账号，传入 `role: "teacher"` 会被拒绝。老师必须调用
`provisionTeacherWithFace({ staffName, phone, initialPassword, faceImageBase64, clientRequestId, consent: true })`：
认证账号先以 `BLOCKED` 创建、业务账号及老师主档先以 `ARCHIVED/PENDING` 写入；仅在服务端人脸质量／活体检查、
腾讯人脸库 `CreatePerson` 和 PostgreSQL 的 `face_person_id + ENROLLED + ACTIVE` 同时成功后，才激活 CloudBase 登录。
失败会封存账号；已新建但未落库的人脸库人员会被补偿删除。重试同一 `clientRequestId` 使用确定性人员 ID，能够安全完成一次中断在激活阶段的建档。数据库只保存人员 ID、授权和时间，绝不保存 Base64 人脸图片。

## 046 老师体验额度迁移（先执行）

无论是历史增量库，还是刚由 `schema.rebuild.sql`／`schema.full.sql` 建出的新库，都必须按顺序执行迁移到
`046_teacher_face_and_experience_quotas.sql` 后再部署 v49。该迁移兼容旧增量 `teachers` 表：历史身份证密文／哈希／电话的非空约束会解除，但已有值保留；新老师页面只需要姓名、手机和人脸授权。CloudBase SQL 编辑器不要粘贴完整大文件，应依次执行
`database/cloudbase-console/046-01` 到 `046-08`，每段都单独 `BEGIN/COMMIT`。

046 提供以下总部专用动作：

- `getTeacherExperienceEntitlements({ teacherId })`：读取一个老师的全部配置、充值／月度重置／体验扣减流水；管理查询仍显示封存老师或产品的历史。
- `upsertTeacherExperienceEntitlement({ teacherId, productId, monthlyAllowance })`：只允许活跃、已绑定人脸的老师和活跃产品；每个老师×产品只有一行月度基础额度。
- `rechargeTeacherExperienceEntitlement({ teacherId, productId, unitCount, note, clientRequestId })`：总部独立充值，写入不可变流水，绝不写入客户充值表或客户余额。
- `resetTeacherExperienceQuotas()`：总部手动补跑入口。业务读取、充值和体验核销也会惰性补跑，防止 Timer 延迟造成错误。
- `setMasterStatus({ teacherId, status })` 或 `setMasterStatus({ storeId, status })`：总部按老师／门店主档编号封存或恢复；有登录账号时先封存 CloudBase 认证，再以原子主档更新同步状态。未绑定认证账号的历史主档也可封存，历史数据不删除。

体验办理端由 `faceRecognition/getTeacherExperienceEntitlements({ teacherId, storeId? })` 读取仅活跃老师、活跃产品且可用次数大于零的项目；体验核销仍经 `faceRecognition/createVerificationApplication`，数据库在同一事务中锁定并扣减老师额度，不扣客户余额。

## 环境变量和月度 Timer

除 `BOOTSTRAP_HQ_UID` 外，老师建档还必须在 **staffAccount** 函数（不能只配置在 faceRecognition）配置：

- `FACE_SECRET_ID`、`FACE_SECRET_KEY`、`FACE_GROUP_ID`；`FACE_GROUP_ID` 必须与客户人脸库一致。
- 可选阈值：`FACE_QUALITY_THRESHOLD`、`FACE_LIVENESS_ENABLED`、`FACE_LIVENESS_THRESHOLD`、`FACE_MAX_YAW`、`FACE_MAX_PITCH`、`FACE_MAX_ROLL`。

在 staffAccount 的 CloudBase triggers 配置中创建下列**不含 action、token 或业务参数**的 Timer；控制台时区选择 `Asia/Shanghai`：

```json
{
  "triggers": [
    {
      "name": "reset-teacher-experience-quotas-monthly",
      "type": "timer",
      "config": "0 0 0 1 * * *",
      "enable": true
    }
  ]
}
```

该七段 Cron 在每月 1 日 00:00:00（上海时间）运行。v49 仅接受平台 Timer 事件，并校验保留运行时变量 `TRIGGER_SRC=timer`、函数名、精确触发器名、时间和无终端用户 UID；普通客户端伪造 `Type: Timer` 不能执行重置。不要将密钥写进 Timer JSON。

部署前：

1. 在 CloudBase 新建云函数 `staffAccount`，Node.js 18。
2. 上传本目录两个文件并安装依赖。
3. 在函数环境变量中只配置一次 `BOOTSTRAP_HQ_UID`，值为首个总部管理员完成手机号登录后的 CloudBase UID。
4. 对 `staffAccount` 配置云函数安全规则：仅已登录且非匿名用户可调用。

首次流程：先在 CloudBase 身份认证控制台为总部管理员账号绑定一个中国大陆手机号并设置密码，再把该用户 UID 写入云函数环境变量 `BOOTSTRAP_HQ_UID`。该 UID 会被函数直接识别为总部，不依赖用户描述字段；之后总部即可通过 `provisionStaff` 自动创建员工，用户不能自行注册。

密码由 CloudBase 校验：必须是 8–32 位，且含四类字符（大写、小写、数字、特殊字符）中的至少三类。因此“纯 12 位数字密码”不符合 CloudBase 的安全规则。

活跃且已绑定门店的账号只能通过 `requestOrderVoid` 对本门店已通过的正常充值
（`NEW`）提交一次作废申请。核销工单不提供作废、撤销或修改次数的入口；如核销有误，
必须另行提交充值工单补回次数。`voidVerification` 兼容动作只返回明确的停用错误，
直接调用旧页面或 API 也不能绕过。

核销审核队列只包含补录核销（`SUPPLEMENT`）；正常和体验核销不进入审核队列，历史核销
作废生命周期只保留为审计数据。总部或运营负责审核。运营账号只允许调用 `session`、`listReviewOrders` 和
`reviewOrder`，其他员工、门店、产品、改密与作废申请动作均拒绝。运营按精确编号
读取核销详情和提交审核结果时，均被限制在补录核销，不能借详情或写接口读取、审核
普通、体验或历史作废核销记录。
`session.profile` 同时返回运营个人信息所需的 `phone` 和 `accountStatus`。
审核列表按页最多返回 100 条，并只在第一页返回轻量门店筛选项；按完整工单编号读取详情仍严格限制为 1 条。旧的非分页内部调用保持原返回契约，运营写入前的审核范围复核不会被分页放宽。
`getHqDashboard` 仅允许总部账号调用，为总部全局首页返回真实数据库汇总：
`{ ok, version, range, totals, stores, rows, teacherRows }`。`stores` 始终从
门店主表返回全部门店；所选日期内没有有效业务的门店仍返回，并将充值、核销显示为 0。
不传 `startDate` 和
`endDate` 时，服务端按 `Asia/Shanghai` 当前日期返回包含当天的近 30 个自然日；
自定义日期必须以 `YYYY-MM-DD` 同时传入，开始日期不得晚于结束日期，范围最多
366 日。统计只包含当前仍为 `APPROVED` 的工单，充值按 `unit_count` 汇总并兼容
历史 `VOID` 反向记录，核销包含 `NORMAL`、`SUPPLEMENT` 和 `EXPERIENCE`；
已封存的门店、项目和老师历史数据仍保留。运营账号不在该动作白名单内。
总部首页部署前还需单独执行迁移
`035_hq_dashboard_approved_covering_indexes.sql`，为两张工单表的已通过日期范围聚合提供覆盖索引。

部署 `v49` 前必须确认已按编号执行既有迁移，并继续完成 `037` 至 `046`；
其中 046 是老师人脸、体验额度、封存写入防线及原子体验核销的前置条件。
部署后调用 `{ "action": "health" }`，返回版本必须为 `v49`，并确认
`teacherExperienceResetTimerTriggerName` 为 `reset-teacher-experience-quotas-monthly`。

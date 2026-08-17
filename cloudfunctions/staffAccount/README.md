# staffAccount 云函数

当前版本：`v38`

用于总部自动创建运营、门店和老师账号；前端只传姓名、手机号、角色和初始密码，云函数使用当前登录总部账号进行授权。

部署前：

1. 在 CloudBase 新建云函数 `staffAccount`，Node.js 18。
2. 上传本目录两个文件并安装依赖。
3. 在函数环境变量中只配置一次 `BOOTSTRAP_HQ_UID`，值为首个总部管理员完成手机号登录后的 CloudBase UID。
4. 对 `staffAccount` 配置云函数安全规则：仅已登录且非匿名用户可调用。

首次流程：先在 CloudBase 身份认证控制台为总部管理员账号绑定一个中国大陆手机号并设置密码，再把该用户 UID 写入云函数环境变量 `BOOTSTRAP_HQ_UID`。该 UID 会被函数直接识别为总部，不依赖用户描述字段；之后总部即可通过 `provisionStaff` 自动创建员工，用户不能自行注册。

密码由 CloudBase 校验：必须是 8–32 位，且含四类字符（大写、小写、数字、特殊字符）中的至少三类。因此“纯 12 位数字密码”不符合 CloudBase 的安全规则。

活跃且已绑定门店的账号通过 `requestOrderVoid`（兼容入口 `voidVerification`）
对本门店原工单提交一次作废申请，不新建第二张业务单。
仅以下原工单允许申请：已通过的正常充值（`NEW`）、正常核销（`NORMAL`）和
补录核销（`SUPPLEMENT`）。体验核销（`EXPERIENCE`）及其他业务类型均禁止；
待审核、已驳回、已作废或已经进入过作废审核生命周期的工单也禁止再次申请。
总部或运营负责审核。运营账号只允许调用 `session`、`listReviewOrders` 和
`reviewOrder`，其他员工、门店、产品、改密与作废申请动作均拒绝。运营按精确编号
读取核销详情和提交审核结果时，均被限制在补录核销或已进入作废申请生命周期的待处理
审核工单，不能借详情或写接口读取、审核普通与体验等非审核核销记录。
`session.profile` 同时返回运营个人信息所需的 `phone` 和 `accountStatus`。
`getHqDashboard` 仅允许总部账号调用，为总部全局首页返回真实数据库汇总：
`{ ok, version, range, totals, rows, teacherRows }`。不传 `startDate` 和
`endDate` 时，服务端按 `Asia/Shanghai` 当前日期返回包含当天的近 30 个自然日；
自定义日期必须以 `YYYY-MM-DD` 同时传入，开始日期不得晚于结束日期，范围最多
366 日。统计只包含当前仍为 `APPROVED` 的工单，充值按 `unit_count` 汇总并兼容
历史 `VOID` 反向记录，核销包含 `NORMAL`、`SUPPLEMENT` 和 `EXPERIENCE`；
已封存的门店、项目和老师历史数据仍保留。运营账号不在该动作白名单内。
总部首页部署前还需单独执行迁移
`035_hq_dashboard_approved_covering_indexes.sql`，为两张工单表的已通过日期范围聚合提供覆盖索引。

部署 `v38` 前必须确认已依次执行迁移 `026` 至 `029`，
然后执行 `database/migrations/032_restrict_order_void_eligibility.sql`，并继续完成
`033`、`034` 和 `035`。
部署后调用 `{ "action": "health" }`，返回版本必须为 `v38`。

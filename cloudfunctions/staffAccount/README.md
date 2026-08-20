# staffAccount 云函数

当前版本：`v64`

用于总部账号、门店账号以及现有员工管理能力；云函数使用当前登录总部账号进行授权。

> 当前 `teacher-create.html` 已不再调用本函数的老师 Saga。新建老师改用独立 `teacherCreate v1`，像客户／门店建档一样只提交一个同步请求，不使用 begin、worker、status、result、operationId、051／052 租约或创建 Timer。下面的 v64 老师 Saga 接口仅为旧发布兼容和受控恢复保留，不能再作为当前创建页的部署合同。

旧兼容老师创建会先调用元数据入口 `beginTeacherProvisionWithFace(...)` 取得持久 `operationId`，再以相同请求编号把原始照片交给 `provisionTeacherWithFace(...)` 后台 worker；正常路径只发送一次，只有服务端明确返回 `READY/retrySameRequest` 的 Auth 不确定恢复才允许用同一冻结负载重启。只有人脸质量／活体检查、腾讯人员建档、私有登记照和老师主档全部保存后才会激活账号。通用的
`provisionStaff({ role: "teacher", ... })` 与无脸 `provisionTeacher(...)` 会在任何认证或数据库写入前返回 `TEACHER_FACE_REQUIRED`。老师人脸在新建时一次完成，老师主页不再暴露补拍或更换入口；历史异常资料的 `upsertTeacherFace({ teacherId, faceImageBase64, clientRequestId, consent: true })` 仅保留为受控后台修复能力。历史无脸老师的激活、登录、老师选择、额度配置和普通业务不以照片为门槛，只有体验核销要求已有可用人脸登记照。v64 不再保存腾讯人脸密钥，
而是用现有 CloudBase 服务端密钥签发两分钟、绑定完整负载的内部命令，由已配置的 `faceRecognition v75`
完成质量检测、人脸建档、私有照片留存和数据库切换。新腾讯人脸和新照片均成功后才切换，旧人脸绝不会先删除。
人员 ID 同时绑定具体 `teacherId`、`staffId` 和 JPEG SHA-256，所以同一真人、
同一张脸可以分别创建多个老师账号，各账号仍拥有互不覆盖的人员记录；手机号仍是登录账号唯一键。
相同账号用相同照片重试保持幂等，相同编号换照片也不会把旧人脸与新登记照误配。
相同 `clientRequestId` 和同一照片可安全重试，
不同编号可以替换人脸。数据库只保存人员 ID、授权、时间和私有不可变登记照引用，绝不保存 Base64 人脸图片或公开地址。
`beginTeacherProvisionWithFace({ staffName, phone, initialPassword, clientRequestId, consent, faceImageSha256, faceImageBytes })` 不接收 Base64 原图、不调用 Auth／人脸／照片或业务主档，只校验总部权限、结构和元数据并持久取得操作租约，随后快速返回 `operationId`、`status`、`stage`、`workerReady`、`retrySameRequest` 与 `retryAfterSeconds`。浏览器再用完整负载调用 `provisionTeacherWithFace(...)`，但不等待其长任务完成；该 worker 仍是实际建号并登记人脸的唯一写入口。

v64 延续全有或全无的老师 Saga，并把浏览器等待拆成 `begin → 后台 worker → 纯读 status → 成功只读结果`。`getTeacherFaceOperationStatus({ operationId, readOnly: true })` 始终只读取数据库，不会启动 worker、缩短租约或同步补偿；即使旧调用方漏传 `readOnly` 也仍保持纯读。`READY` 才允许同请求启动／重启 worker，`WORKER_RUNNING` 只等待，`CANCELLED + cleanupComplete` 才允许生成新请求，`SUCCEEDED` 则用 `readTeacherProvisionResult({ operationId, ...原完整负载 })` 执行严格最终读回并返回五重成功证明。结果读取会精确复核请求编号、手机号、姓名、图片摘要／字节数、操作人及 owner hash，但不 acquire／claim／transition，也不改变 generation 或 lease，因此客户端 watchdog 后可安全重试，多个结果读取不会互相取消。补偿只由显式 `reconcileTeacherFaceOperation` 或受信任 Timer 执行。

v64 以迁移 051 的持久操作租约和迁移 052 的 Auth 创建回执隔离并发、迟到提交和云函数硬终止。它与门店／客户创建的快速路径一致：CloudBase `createUser` 成功返回且 `Data.Uid` 精确等于本次预绑定的确定性 UID 时，先持久保存返回 UID 和回执时间，然后直接继续，不等待用户列表读副本。账号从创建起固定为 `BLOCKED`，只有人脸、私有照片、业务主档均完成并通过最终 Auth 权威回读后才激活。仅当创建响应超时、断网、限流、5xx、缺失 UID 或成功响应丢失等真正无法判断是否提交时，才按 0／250／500／1000ms 短回读确定性 UID。`createUser` 返回 duplicate 但精确 UID 尚不可读时也属于这种不确定，不会把未读到的账号误判为他人账号；只有实际读到 UID 且手机号／用户名／租约不匹配时才返回 `AUTH_ACCOUNT_ALREADY_EXISTS`。仍不能确认时，操作保持 `RUNNING`，先把本次随机 invocation nonce 原子切换为 `V64_WORKER_READY`，再返回 `retrySameRequest: true`、原 `operationId` 和短 `retryAfterSeconds`；下一次同负载调用必须原子提升 generation 并取得新的单执行 nonce，两个云函数实例不能同时进入 Auth、业务主档或人脸写入。前端必须保留原 `clientRequestId` 与完整负载，且只有纯读状态返回该标志才重启 worker；普通网络/5xx 不能自行推断上次执行已经结束。明确的参数、密码、凭证或权限拒绝仍走原补偿路径，不会伪装成可重放状态。v59—v62 已存在的 90 秒 `CLEANUP_PENDING` 记录仍保留原安全核对与 Timer 兼容逻辑；v64 的新 Auth 不确定不再进入该前台栅栏。成功前仍必须分别权威回读腾讯 Person、私有桶登记照的
精确字节／SHA-256、faceRecognition 数据库引用、staffAccount 最终老师／账号 `ACTIVE` 状态及
CloudBase Auth 同 UID／手机号的 `ACTIVE` 状态；响应只会在全部成立时返回
`readbackConfirmed: true`。任何阶段失败都会用同一签名和图片摘要撤销本次 Person／照片，删除本次
老师、员工账号及级联身份，再删除本次生成的 Auth 用户；删除结果也必须通过独立读回确认。若某项
补偿无法确认，只返回 `TEACHER_PROVISION_COMPENSATION_PENDING` 和 `cleanupPending`，绝不会返回
创建成功。已有老师补录／替换人脸不进入新建 Saga，也不会用本地数据库一行记录冒充远端读回证明；
失败时保留原老师资料。

每次 `UPSERT` 保持生成随机 256-bit owner token；`PROVISION` 则用 `CLOUDBASE_APIKEY` 派生的 HMAC 绑定操作类型、请求编号、手机号、姓名、JPEG 摘要／字节数、人员库、照片桶、操作人及初始密码摘要，从而为完全相同的在途请求派生同一 256-bit owner token。原始 API Key、密码及密码摘要都不写入数据库；数据库只保存 owner token 的 SHA-256，
并以 `operationId + generation` 作为写入栅栏。过期执行只能进入 `CLEANUP_PENDING`，不能继续创建。
总部可调用 `reconcileTeacherFaceOperation({ operationId })` 手工清理，并可用 `getTeacherFaceOperationStatus({ operationId, readOnly: true })` 纯读轮询而不重放创建或触发清理；下述受信任 Timer 也会每 1 分钟
最多接管 5 条过期操作。清理必须先恢复／清空精确人脸指针，再删除本次业务账号和本次租约拥有的
CloudBase Auth 用户；同手机号但不同 UID、不同租约或不同老师编号不会被认领、封禁或删除。

## 046 老师体验额度、047 运营身份下线、048 生命周期与 049 老师体验人脸

无论是历史增量库，还是刚由 `schema.rebuild.sql`／`schema.full.sql` 建出的新库，都必须先完成
`046_teacher_face_and_experience_quotas.sql`。046 兼容旧增量 `teachers` 表：历史身份证密文／哈希／电话的非空约束会解除，但已有值保留；048 允许历史无脸老师保持原账号状态并在获得授权后补充或替换人脸，但新建老师仍必须当次完成人脸。CloudBase SQL 编辑器不要粘贴完整大文件，应依次执行
`database/cloudbase-console/046-01` 到 `046-08`，每段都单独 `BEGIN/COMMIT`。

046 完成后的上线顺序固定为：

1. 部署 `faceRecognition v69` 和本函数 `staffAccount v55`，并分别调用 `health` 确认版本；
2. 在仅限总部使用、已加载当前 `cloudbase-phone-auth.js` 的临时维护页面中，以**已登录总部**身份在浏览器控制台执行 `await CloudBasePhoneAuth.retireOperationAccounts()`，等待 `ok: true`；它会逐个把旧运营账号的 CloudBase 登录凭据设为 `BLOCKED`。该维护页不是最终静态发布；失败时先修复原因并安全重试，不能继续下一步；
3. 只有该动作成功后，才执行 `047_retire_operation_accounts.sql`（CloudBase SQL 编辑器依次执行 `047-01-retire-operation-accounts.sql`、`047-02-hq-reviewer-guard.sql`）；
4. 依次执行 `048_optional_teacher_face_and_experience_quota_lifecycle.sql`（CloudBase SQL 编辑器则依次执行 `048-01` 至 `048-07`）；
5. 部署 `faceRecognition v71` 和本函数 `staffAccount v55`，完成 048 的兼容上线；
6. 依次执行 `database/cloudbase-console/049-01` 至 `049-13`，再执行只读的 `049-readonly-verify.sql`；
7. 依次执行 `database/cloudbase-console/050-01` 至 `050-07`，再执行 `050-readonly-verify.sql`，7 项必须全部 `READY`；
8. 依次执行 `database/cloudbase-console/051-01` 至 `051-10`，再执行 `051-readonly-verify.sql`，所有项目必须全部 `READY`；
9. 执行 `database/cloudbase-console/052-01-auth-create-receipt.sql`，再执行 `052-readonly-verify.sql`，5 项必须全部 `READY`；
10. 部署 `faceRecognition v75`、本函数 `staffAccount v64` 和 `verificationPhoto v4`，分别调用 `health` 确认版本；
11. 为 `staffAccount` 创建月度额度 Timer 和每 1 分钟人脸补偿 Timer；
12. 最后部署当前静态前端并强刷浏览器。

047 保留历史审核人、账号 ID 和业务外键，但会将旧运营账号、身份、权限和范围统一封存，并在数据库层禁止重新创建、激活或复用运营身份。该维护动作没有日常页面入口。

048 提供以下总部专用动作：

- `getTeacherExperienceEntitlements({ teacherId })`：读取一个老师当前活跃配置、充值／月度重置／体验扣减／配置删除历史；每项返回 `totalExperienceCount`（全历史体验核销总次数），不受本月重置影响。
- `upsertTeacherExperienceEntitlement({ teacherId, productId, monthlyAllowance })`：只允许活跃老师和活跃产品；每次配置立即把当前可用次数精确改为 `monthlyAllowance`，不结转此前余额。每个老师×产品仍只有一条可审计额度主线。
- `deleteTeacherExperienceEntitlement({ teacherId, productId })`：封存当前产品额度配置，使该产品可再次选择并重新配置；绝不删除充值、重置或体验核销历史。
- `rechargeTeacherExperienceEntitlement({ teacherId, productId, unitCount, note, clientRequestId })`：总部独立充值，写入不可变流水，绝不写入客户充值表或客户余额。
- `resetTeacherExperienceQuotas()`：总部手动补跑入口。每月上海时间 1 日 00:00 的 Timer 和惰性补跑只处理活跃老师、活跃产品及活跃额度配置。
- `setMasterStatus({ teacherId, status })` 或 `setMasterStatus({ storeId, status })`：只允许总部按老师／门店主档编号封存或恢复。门店主档与关联 PostgreSQL 门店账号在同一 SQL 语句中同步；封存后即使 CloudBase 用户管理临时不可用，后端也会拒绝该账号的一切业务登录。历史或压力数据的 `auth_uid` 若在 CloudBase 中明确不存在，封存仍成功并返回提示；恢复时找不到真实认证账号则自动保持封存并返回明确错误。历史数据不删除。

体验办理端由 `faceRecognition/getTeacherExperienceEntitlements({ teacherId, storeId? })` 读取仅活跃老师、活跃产品且可用次数大于零的项目；体验核销先用 `verifyTeacherExperienceFace` 比对老师本人，随后经 `createVerificationApplication` 在同一数据库事务中固化老师登记照、老师现场照并扣减老师额度。工单仍保留所选客户的 `customer_id`，但不读取或扣减客户余额。普通核销继续比对客户人脸并扣减客户余额。

## 环境变量和月度 Timer

除 `BOOTSTRAP_HQ_UID` 外，**staffAccount** 仅需它原本已有的 `CLOUDBASE_ENV_ID`（或 `TCB_ENV`）和平台托管的
`CLOUDBASE_APIKEY`（兼容 `CLOUDBASE_SERVICE_ROLE_KEY`）。该 Key 只用于服务端存储／内部委托签名，不会进入响应、日志或前端。

`FACE_SECRET_ID`、`FACE_SECRET_KEY` 及人脸阈值只配置在 **faceRecognition v75**；不要在
staffAccount 复制腾讯人脸密钥。`FACE_GROUP_ID` 和 `CUSTOMER_PHOTO_BUCKET_ID` 必须在
`staffAccount` 与 `faceRecognition` 各配置一份完全相同的值（照片桶默认值均为
`customer-photos`）：新操作会把两者写入迁移 051 租约，后续读回／回滚使用持久值，因此未来修改
环境变量不会把旧 Person 或候选私有照片遗留在错误人员库／桶。老师 JPEG 最大 3 MiB，以便两次
同步调用都与 6 MB 事件上限保持安全余量。
staffAccount 调用 faceRecognition 的单次 SDK 超时固定为 60 秒；CloudBase 控制台必须把
`faceRecognition` 函数超时设为 90 秒（不得高于该值），并把可能顺序清理 5 条过期操作的 `staffAccount` 函数超时设为
600 秒。v64 会记录每次子调用的开始时间；若 60 秒客户端超时，但 faceRecognition 仍可能在
90 秒平台生命周期内迟到提交，最终回滚会等待至最后一个子调用的 90 秒截止点再加 5 秒安全余量，
然后重新删除并读回确认。两端超时不足或把 faceRecognition 平台超时擅自调高都会破坏该完成栅栏；
如需调高 faceRecognition 超时，必须同步提高代码中的最大存活期、staffAccount 超时和相关测试。

在 staffAccount 的 CloudBase triggers 配置中创建下列**不含 action、token 或业务参数**的 Timer；控制台时区选择 `Asia/Shanghai`：

```json
{
  "triggers": [
    {
      "name": "reset-teacher-experience-quotas-monthly",
      "type": "timer",
      "config": "0 0 0 1 * * *",
      "enable": true
    },
    {
      "name": "reconcile-teacher-face-operations",
      "type": "timer",
      "config": "0 * * * * * *",
      "enable": true
    }
  ]
}
```

第一个七段 Cron 在每月 1 日 00:00:00（上海时间）运行；第二个每 1 分钟扫描一次迁移 051 中
已过期且尚未完成清理的 `RUNNING`／`CANCELLED`／`CLEANUP_PENDING`，并会让已等待 90 秒、尚未进入人脸／照片／业务写入的 v59—v62 历史认证不确定操作提前进入安全核对，按最早顺序最多处理 5 条。v64 的新 Auth 不确定操作保持 `RUNNING`并由同请求立即续办；若客户端永不回来，仍由未改动的 12 分钟租约过期扫描安全清理。因此定时触发器的名称、Cron 和数量都不需要修改。
单条失败会保留 `cleanupPending` 供下一轮重试，不会阻止后续条目。v64 仅接受平台 Timer 事件，
并校验保留运行时变量 `TRIGGER_SRC=timer`、函数名、精确触发器名、时间和无终端用户 UID；普通客户端
伪造 `Type: Timer` 不能执行重置或补偿。不要将 action、token、operationId 或密钥写进 Timer JSON。

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
作废生命周期只保留为审计数据。只有总部负责审核；`listReviewOrders` 和 `reviewOrder` 都会拒绝门店、老师和已下线运营身份。审核列表按页最多返回 100 条，并只在第一页返回轻量门店筛选项；审核工作台调用
`listReviewOrders({ paged: true, pageNumber, limit })` 时，服务端返回筛选总数、总页数和指定页，支持直接跳转到任意有效页码（1–10000）。旧的 cursor 读取契约仍保留给既有调用方；按完整工单编号读取详情仍严格限制为 1 条。
`getHqDashboard` 仅允许总部账号调用，并拆成严格有界的两种读取，避免大数据时超过
CloudBase 6 MB 同步响应限制：默认 `{ mode: "overview" }` 返回
`{ ok, version, mode, range, totals, charts }`，其中 `charts` 只含门店／项目／老师各
Top 10；`{ mode: "ranking", dimension, pageNumber, pageSize }` 返回
`{ ok, version, mode, ranking }`，排名每页默认100条、最多500条，并包含总条数、总页数和
四类业务总和。浏览器据此分页、跳转页码（最多浏览前100万条），并在导出 CSV 时以500条为批次顺序读取；
单次导出最多10,000条，超出时前端会要求缩小统计范围，绝不要求服务端返回全量门店×项目或老师×项目聚合行。
门店排名仍从门店主表出发，因此无业务门店会以0显示。
不传 `startDate` 和 `endDate` 时，服务端按 `Asia/Shanghai` 当前日期返回包含当天的近30个自然日；
自定义日期必须以 `YYYY-MM-DD` 同时传入，开始日期不得晚于结束日期，范围最多366日。统计只包含当前
仍为 `APPROVED` 的工单，充值按 `unit_count` 汇总，核销包含 `NORMAL`、`SUPPLEMENT` 和
`EXPERIENCE`；已封存的门店、项目和老师历史数据仍保留。
总部首页部署前还需单独执行迁移
`035_hq_dashboard_approved_covering_indexes.sql`，为两张工单表的已通过日期范围聚合提供覆盖索引。

部署 `v64` 前必须确认已按编号执行既有迁移，并完成至 `052`。052 只在 051 操作租约上增加 Auth 实际返回 UID 和回执时间，不改写历史业务数据。
其中 046 是老师人脸、体验额度、封存写入防线及原子体验核销的前置条件，048 让历史老师状态不再受人脸字段约束并增加额度删除／重配生命周期，049 把新体验核销的人脸主体切换为老师，050 补齐遗留主档并修复额度单独充值歧义，051 提供老师人脸跨服务 Saga 的持久 owner/generation 栅栏，052 保存权威 Auth 创建回执以消除正常成功路径的读副本等待。必须按本节的“既有 046—048 → 049-01..13 → 049 只读验收 → 050-01..07 → 050 只读验收 → 051-01..10 → 051 只读验收 → 052-01 → 052 只读验收 → v75/v64/v4 → 两个 Timer → 静态前端”顺序发布。
部署后调用 `{ "action": "health" }`，返回版本必须为 `v64`，并确认
`teacherExperienceResetTimerTriggerName` 为 `reset-teacher-experience-quotas-monthly`，且
`teacherFaceReconcileTimerTriggerName` 为 `reconcile-teacher-face-operations`、`teacherAuthCreateReceiptFastPath` 为 `true`、`teacherAuthCreateReadbackWindowMs` 为 `1750`、`sameRequestResume` 与 `teacherAuthSameRequestResume` 均为 `true`、`teacherAuthSameRequestRetrySeconds` 为 `2`、`teacherProvisionSingleInvocationGuard`、`teacherProvisionBeginWorkerStatus`、`teacherProvisionReadOnlyStatus` 与 `teacherProvisionReadOnlyResult` 均为 `true`，且 `teacherProvisionBeginAcceptsOriginalImage` 为 `false`。`teacherAuthUncertaintyFenceSeconds` 仍为 `90`，但只供 v59—v62 历史 `CLEANUP_PENDING` 记录兼容清理，不是 v64 新建老师的前台等待时间。

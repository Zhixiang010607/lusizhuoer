# faceRecognition 云函数

该函数仅在 CloudBase 后端运行，用于门店与总部共享的客户建档、照片质量检测、私有照片留存、人脸人员库录入、1:1 核验和业务数据接口。客户不需要提供身份证。核销单照片的列表、原图、导出及三个补充照片位上传已拆到独立的 `verificationPhoto v5`；当前静态前端不再把这些照片动作发给本函数。

当前版本：`v82`

v82 与 `verificationPhoto v5` 共享同一份经过权限校验的照片服务实现，但由启动模式限制可调用动作。`faceRecognition` 保留人脸 SDK 和人脸／业务动作；`verificationPhoto` 的部署包不安装腾讯人脸 SDK，也拒绝所有人脸、客户、充值和建单动作。部署和环境变量详见 `../verificationPhoto/README.md`。

## 必需环境变量

- `FACE_SECRET_ID`
- `FACE_SECRET_KEY`
- `FACE_GROUP_ID=lusizhuoerdatabase`
- `CLOUDBASE_ENV_ID=rusizhuoer-d9gbcsgym07651694`：必须与 PostgreSQL 实例、PG 云存储桶和下面的 service role key 属于同一个 CloudBase 环境；运行平台已可靠注入同值 `TCB_ENV` 时可由它替代。
- `CLOUDBASE_APIKEY`：平台托管的 CloudBase PG 云存储 service-role API Key，只能保存在云函数环境变量中。代码仍兼容旧变量 `CLOUDBASE_SERVICE_ROLE_KEY`；两者同时存在时优先使用 `CLOUDBASE_APIKEY`。

不要把腾讯云密钥写入前端 JavaScript、README 或 GitHub。

`faceRecognition` 与 `verificationPhoto` 必须在各自函数的环境变量页面分开配置；每个变量名称和值各占一行／一个输入项。不要把整段 `KEY=value` 文本、其他变量名、引号或换行一起粘进某一个变量值。两个函数使用同一个安全随机、至少 32 位的 `VERIFICATION_PHOTO_CLEANUP_TOKEN`，但该值只存在环境变量中，不写进 triggers-only 配置。

## 老师与门店工作台（v82）

新建老师只调用独立的 `teacherCreate v6/createTeacher`，该函数只创建账号和老师
主档，不接收图片或建立老师人脸。`faceRecognition v82` 不接受老师创建、照片检测、
补录、替换、回读、回滚或最终清理委托，也不读取迁移 051 的老师人脸操作租约。

v82 保留老师赠送体验流程：只有当前登录的老师账号可以发起，`teacher_id` 由服务端绑定到该账号，门店与总部账号即使直接调用接口也会被拒绝。正常核销和体验核销都调用同一个 `verifyCustomerFace` 与 `persistVerifiedFaceEvidence`，现场只对所选客户的 `PersonId` 做 1:1 比对。

老师工作台的 `getTeacherWorkspace` 提供四类有效业务视图（核销、充值、体验、退费）、上海业务日期范围、按项目汇总矩阵，以及当前老师所有活跃项目的体验剩余次数。`getTeacherBusinessCustomers` 只按该老师已通过的 `NORMAL`／`EXPERIENCE` 核销建立客户关联，并分别分页返回活跃用户与封存用户；充值和退费不会建立老师客户关联。v82 允许老师在相同服务端关联校验下读取该客户的私有建档照、修改备注和留言，但不能访问无关客户或修改客户状态。门店主页按客户 `created_store_id` 分别分页返回活跃与封存用户，并通过 `queryStoreBusinessRecords` 按相同日期范围读取四类已生效明细；门店业务区与老师业务区共用一套产品行、四类业务列的响应式版式，但不显示老师体验额度卡。门店全历史查询必须显式提交 `allTime=true`，避免缺省日期被误解为全历史；自定义范围仍最多 366 天。列表和汇总只统计 `APPROVED` 记录；账号身份、时间范围和分页游标均由服务端校验。迁移 055 同时移除订单触发器和核销主体锁中的旧老师人脸门禁；迁移 056 消除体验核销写入函数的额度列名歧义；老师主档、账号、额度配置、客户档案照与客户现场 1:1 人脸校验仍然必须有效。

老师不再采集人脸。新体验单固定保存客户建档照和客户现场照；历史老师人脸体验单
继续按真实 `face_subject_type=TEACHER` 只读展示，不会伪改照片主体。

迁移 054 将数据库原子入口切换为 `create_experience_verification_with_customer_face_photo`：同一事务确认提交账号就是额度所属老师、消费一条老师体验额度、绑定客户两张人脸照片并写入设备开启信号。体验核销不读取或扣减客户购买余额。

体验办理页面使用 `getTeacherExperienceEntitlements({ teacherId, storeId })`，该动作只接受老师账号且只返回本人额度。调用者、门店、老师、产品及产品额度配置都必须活跃；每项还返回不受月初重置影响的 `totalExperienceCount`。封存主档或已删除的额度配置不能出现在新业务选择中，但历史工单和统计仍按事件保留。

## 推荐环境变量

- `FACE_QUALITY_THRESHOLD=70`：建档照片质量最低分。
- `FACE_VERIFY_THRESHOLD=60`：已选客户 1:1 核销最低相似度；同时要求腾讯云 `IsMatch=true`。
- `FACE_MAX_YAW=20`
- `FACE_MAX_PITCH=20`
- `FACE_MAX_ROLL=15`
- `FACE_LIVENESS_ENABLED=false`：未开通高精度静态活体服务前保持 `false`；开通后改为 `true`。
- `FACE_LIVENESS_THRESHOLD=40`：腾讯云高精度静态活体推荐阈值。
- `CUSTOMER_PHOTO_BUCKET_ID=customer-photos`
- `CUSTOMER_PHOTO_URL_TTL_SECONDS=120`：核销／充值选择客户时，私有照片临时地址的有效秒数；允许 30--600 秒。
- `VERIFICATION_PHOTO_BUCKET_ID=verification-photos`：可选的核销证据专用私有 PG 存储桶。也可以与 `CUSTOMER_PHOTO_BUCKET_ID` 一样都配置为现有的 `customer-photos`；v82 会去重候选桶，并在写入照片前查询当前 PostgreSQL 环境的 `storage.buckets`，只选择确实存在的桶 ID。两个云函数必须配置相同值。
- `VERIFICATION_PHOTO_URL_TTL_SECONDS=900`：核销缩略图和按需原图的签名地址有效秒数；允许 60--900 秒。默认 15 分钟以复用浏览器私有缓存，地址仍会过期且不会写入持久存储。
- `VERIFICATION_PHOTO_UPLOAD_TTL_SECONDS=600`：一次补充照片上传任务在业务层的有效秒数；允许 120--900 秒。到期后数据库拒绝提交并释放该核销单的单任务锁。取消／过期对象要等创建满安全等待期后再做最终清理。
- `VERIFICATION_FACE_EVIDENCE_TTL_MINUTES=30`：人脸比对通过后、正式提交核销单前的照片草稿有效分钟；允许 5--120 分钟。
- `VERIFICATION_PHOTO_CLEANUP_TOKEN`：至少 32 位随机清理凭证，只放云函数环境变量；仅供控制台／管理端手工补跑，不写入定时触发器配置。

## 拍摄和质量要求

- 核销人脸凭证保存为 JPEG 3:4 竖图，最长边优先保留到 1920 px、质量系数 0.92；仅在超过 3 MB 时逐级缩小。另生成最长边 480 px、最多 384 KB 的独立缩略图。原图和缩略图的 Base64 合计稳定低于云函数 6 MB 同步事件上限，详情页不会为了列表预览下载原图。
- 图片只能有一张人脸，人脸宽和高均至少 100 px。
- 不允许口罩、闭眼、明显低头、歪头或侧脸。
- 后端会再次执行质量检测，不能依赖前端结果。
- `CreatePerson` 使用算法模型 3.0、`QualityControl=3`、`UniquePersonControl=0`。
- 同一自然人可以建立多个独立客户档案；每次建档都会生成不同的客户编号和腾讯人脸 `PersonId`。系统不会按人脸、姓名或生日阻止重复建档。
- 页面为每次明确的新建档操作生成 `clientRequestId`；同一次提交因网络超时而重试时返回原客户档案，不会误建第二条。重新拍照或修改资料后再次提交会生成新的客户编号。
- 核销必须先选中具体客户编号，再使用该档案绑定的 `PersonId` 做 1:1 人脸验证，因此多个档案不会在核销时互相替代。
- 已经选择客户的核销只调用 `VerifyFace`，现场照片只与数据库中该客户的 `PersonId` 做 1:1 比对，不搜索其他客户。
- 人脸比对通过后，现场原图和缩略图立即写入私有核销照片桶并生成短时证据令牌；正式建单时数据库在同一个事务中消费令牌并把不可修改的人脸照片绑定到核销单。上传或绑定失败时不得建单。
- 系统不提供 `SearchPersons` 或其他 1:N 查人入口。必须先按业务编号选定客户或老师，再用该档案在数据库中绑定的 `PersonId` 调用 `VerifyFace` 做 1:1 比对。

## 云存储

- PG 存储桶：`customer-photos`
- 访问权限：私有
- 单文件限制：5 MB
- MIME 白名单：`image/jpeg`
- 对象路径：`<storeId>/<customerCode>/<timestamp>.jpg`

该桶不为 `anon` 或 `authenticated` 创建任何 RLS Policy，客户端访问默认拒绝；控制台因此显示“未配置 RLS、API 访问将被拒绝”属于预期状态。官方 `service_role` 具备 `BYPASSRLS`，只有配置同环境服务端 API Key 的云函数可以读写。不要为消除控制台提示把照片桶公开或给网页账号增加整桶权限。数据库保存 `pg://<bucketId>/<objectName>` 私有引用，不保存公开下载地址。

可以另建 PG 存储桶 `verification-photos` 以便分开管理和保留策略，但不是必需条件。v82 与 `verificationPhoto v5` 按 `VERIFICATION_PHOTO_BUCKET_ID`、`CUSTOMER_PHOTO_BUCKET_ID` 的顺序对候选桶去重，并在写入前用 `storage.buckets.id` 预检当前数据库环境中实际存在的桶；两个环境变量都填写 `customer-photos` 时只检查、使用这一个桶。如果候选桶都不存在，服务端直接返回 `PHOTO_BUCKET_NOT_FOUND`：

- 访问权限：私有；不要给 `anon` 或 `authenticated` 添加 SELECT/INSERT/UPDATE/DELETE Policy。
- 单文件限制：5 MB；MIME 白名单仅 `image/jpeg`。
- CORS：当前补充照片通过 `verificationPhoto` 云函数传输，不再要求浏览器 `PUT` CORS。保留正式静态站点所需的受限读取配置即可；不要使用 `*` 来源，也不要开放浏览器列桶、删除或覆盖权限。桶仍保持私有且不给 `anon`／`authenticated` 建 Policy。
- 对象路径：人脸凭证使用 `face-evidence/<store>/<staff>/<token>/...`，新版补充照片使用 `records/<verificationId>/slot-<n>/direct-<timestamp>-<server nonce>.jpg`；路径全部由云函数随机生成，浏览器输入不会进入路径，每次替换都使用新对象名且签名禁止覆盖。
- 每单固定展示 2 张人脸照片和 3 个补充照片位。迁移 054 后，正常核销与新体验核销的前两张都是客户登记照和客户现场照；迁移 049 至 053 期间生成的历史老师脸体验单继续标记为 `TEACHER` 并如实展示，不会把旧照片伪装成客户。补充照片只保存一份高清 JPEG，提交时服务端验证实际字节数、MIME、JPEG 文件头、真实尺寸和 SHA-256；缩略图由 CloudBase 图片处理按需生成。
- 当前网页固定调用独立的 `verificationPhoto v5`，其响应为 `uploadMode=FUNCTION`：数据库先建立／复用上传请求并锁定“每单一个进行中任务”，网页再把压缩 JPEG 和该任务的短时证明提交给函数；函数只能写入任务已锁定的同一桶和随机对象路径。这样不依赖浏览器 PUT 签名，取消、重试、提交人和 24 小时限制仍由迁移 039 原子函数控制。
- `faceRecognition v82` 暂时保留 v52 的 `DIRECT`／精确 `FUNCTION` 回退实现，供旧客户端平滑升级和共享服务测试；当前生产前端不调用这组兼容照片动作。两个函数均不会接受客户端指定的桶或对象路径。
- 原图和缩略图设置私有长期缓存；数据库从不保存签名 URL。详情首屏仅以最多 2 路并发准备 5 张缩略图，不提前签发 5 张高清原图；点击时才重新校验权限、写查看审计并取得该照片的短时原图地址。页面先显示缩略图，再无闪烁替换为高清图；同页重复查看可复用仍有效的私有地址，并把已解码原图限制为最多 2 张。
- 在本函数配置名为 `cleanup-verification-photo-drafts-hourly` 的每小时 Timer，只清除过期且未建单的人脸照片草稿。触发器使用 CloudBase `triggers` 配置，不携带 `action` 或清理凭证；v82 会严格验证平台保留的 `TRIGGER_SRC=timer`、函数名、事件类型、触发器名、时间和无终端用户 UID。取消／过期的迁移 039 补充照片任务由 `verificationPhoto` 的另一个 Timer 清理；两个触发器名不要互换。

## 部署

把本目录中的 `index.js`、`package.json` 和 `README.md` 放在 ZIP 根目录上传。函数入口为 `index.main`，部署时安装 `package.json` 依赖。

在 `faceRecognition` 的触发器配置编辑器中填写以下完整配置。CloudBase 只接受顶层 `triggers` 数组；不要在这里填写业务事件、`action` 或 `cleanupToken`：

```json
{
  "triggers": [
    {
      "name": "cleanup-verification-photo-drafts-hourly",
      "type": "timer",
      "config": "0 0 * * * * *"
    }
  ]
}
```

该七段 Cron 每小时整点运行。需要从控制台手工补跑时，使用 `{ "action":"cleanupVerificationPhotoDrafts", "cleanupToken":"与环境变量完全一致的真实值" }`；手工入口仍要求至少 32 位凭证且调用中没有终端用户 UID，不能由普通网页账号调用。

首次上线迁移 039 时必须安排一个短暂停写窗口，并严格按下列顺序部署，避免旧页面绕过单任务锁：

1. 在完整 PostgreSQL migration 工具中执行 `database/migrations/039_direct_verification_photo_upload.sql`；腾讯云 SQL 编辑器则依次单独执行 `039-01`、`039-02`、`039-03`、`039-04`、`039-05`。
2. 执行 `database/migrations/040_fix_verification_photo_commit_ambiguity.sql`；腾讯云 SQL 编辑器只需执行一次 `040-01-fix-verification-photo-commit-ambiguity.sql`。已经完成 039 的生产库不要重跑 039。
3. 完成 046、总部封锁旧运营凭据、047 和 048 后，依次执行 `049-01` 至 `049-13`，再运行 `049-readonly-verify.sql`，全部必须为 `READY`。049 是向前迁移，不要修改或重跑生产已执行的 048。
4. 执行迁移 050 的 7 段控制台 SQL并确认只读验收全部 `READY`，再按 053 指引退役旧老师人脸 Saga。`faceRecognition v82` 不依赖迁移 051／052，也不需要老师人脸操作恢复 Timer。
5. 完整执行迁移 054（CloudBase SQL 编辑器使用 `054-01-teacher-only-customer-face-experience.sql`），把新体验核销切换为老师账号赠送、客户人脸凭证。
6. 将 `faceRecognition` 执行超时设为 **90 秒**；本次同时部署
   `faceRecognition v82`、`staffAccount v67` 和 `teacherCreate v6`。
   `teacherCreate` 可设为 **60 秒、至少 256 MB**，且不再需要任何 FACE 或照片桶变量。
7. 完整执行迁移 055 并确认 3 行全部 `READY`，移除充值、退费、核销和体验核销中的旧老师人脸门禁；再执行 `056-01-experience-quota-column-ambiguity.sql`，确认返回 `READY`。
8. 调用 `faceRecognition` 的 `health` 确认 `version=v82`，再发布当前静态前端并强制刷新浏览器。

当前切换顺序为“确认 048—050 与 053 已完成 → 执行 054 → 部署
`faceRecognition v82`、`staffAccount v67`、`teacherCreate v6` → 分别 health →
发布当前静态前端”。不要再发送任何老师人脸 action；新体验核销只能调用客户 1:1
人脸验证。

部署后测试：

```json
{ "action": "health" }
```

应返回：

```json
{
  "ok": true,
  "version": "v82",
  "photoBucketId": "customer-photos",
  "verificationPhotoBucketId": "verification-photos",
  "verificationPhotoFallbackBucketId": "customer-photos",
  "verificationPhotoUrlTtlSeconds": 900,
  "verificationPhotoUploadTtlSeconds": 600,
  "verificationPhotoCleanupConfigured": true,
  "verificationPhotoCleanupTimerTriggerName": "cleanup-verification-photo-drafts-hourly",
  "verificationPhotoServiceRoleKeyConfigured": true,
  "verificationPhotoBucketMetadataReady": true,
  "verificationPhotoServiceRoleStorageReady": true,
  "livenessEnabled": true
}
```

上例假设另建了 `verification-photos`。如果当前环境把 `VERIFICATION_PHOTO_BUCKET_ID` 与 `CUSTOMER_PHOTO_BUCKET_ID` 都配置为 `customer-photos`，健康检查中的 `photoBucketId`、`verificationPhotoBucketId` 和 `verificationPhotoFallbackBucketId` 都返回 `customer-photos` 才是正确结果。`health` 展示的是环境变量配置；部署前还必须在同一个 CloudBase 环境的 PostgreSQL SQL 编辑器执行以下只读检查，确认真实桶和迁移 039 都存在：

```sql
SELECT
  CURRENT_DATABASE() AS database_name,
  TO_REGCLASS('public.verification_photo_upload_requests') AS upload_request_table,
  EXISTS (
    SELECT 1
      FROM storage.buckets
     WHERE id = 'customer-photos'
  ) AS configured_bucket_exists;

SELECT id, name, public, file_size_limit, allowed_mime_types
  FROM storage.buckets
 WHERE id IN ('customer-photos')
 ORDER BY id;
```

对上述 `customer-photos` 配置，第一条应返回非空 `upload_request_table` 和 `configured_bucket_exists=true`，第二条应恰好返回一行 `customer-photos`，同时 `public=false`、`file_size_limit` 不少于 5242880（5 MB）、`allowed_mime_types` 为空或包含 `image/jpeg`。如果使用专用桶，把查询中的候选集合改为 `('verification-photos', 'customer-photos')`，并确认至少一个 ID 与两个云函数的环境变量逐字一致。SQL 不能核对云函数 API Key；还要确认 `CLOUDBASE_ENV_ID`、优先变量 `CLOUDBASE_APIKEY`（或兼容变量 `CLOUDBASE_SERVICE_ROLE_KEY`）和执行 SQL 的 PostgreSQL 实例都属于同一个 CloudBase 环境。两个 health 的 `verificationPhotoServiceRoleStorageReady=true` 会额外使用各自的服务端 Key 对真实桶执行只读 `listObjects`，可直接识别错环境、失效 Key 或权限异常；若为 `false`，查看同响应的错误码和请求 ID。

## 支持的动作

- `validateCapture`：拍照后立即检查单人、人脸尺寸、质量、口罩、闭眼和姿态。
- `registerCustomer`：服务端质量检查、可选活体检测，然后以新的唯一客户编号和 `PersonId` 入人员库、上传私有照片并写客户表。同一张脸、相同姓名或相同生日都允许建立新的独立客户档案。
- `getTeacherBusinessContext`：仅允许活跃老师账号调用，返回当前老师本人身份和可选择的活跃门店。老师必须先选择本次办理门店，后续每个业务动作都会由服务端重新校验老师身份与门店状态。
- `listActiveStoreCustomers`：门店账号按 UID 锁定自身门店；老师账号必须提交一个真实活跃门店 ID。只返回目标门店 `customer_status='ACTIVE'` 客户的编号、姓名和生日。初始下拉最多返回 100 位，更多客户使用姓名＋生日在服务端精确查询；不会预取备注、状态或业务汇总。
- `queryStoreCustomers`：总部与门店共用的真实客户查询。服务端先根据 CloudBase UID 验证活跃身份；总部可查看全部门店或选择一个真实门店，门店账号始终锁定到自身绑定门店，老师无权调用。结果使用 `(created_at,id)` 游标分页且每页最多 100 条，业务阶段、活跃／封存及总数均由数据库对完整筛选范围汇总。
- `queryStoreBusinessRecords`：总部与门店共用的充值／核销查询。总部可查看全部门店或选择一个真实门店；门店范围只来自服务端 UID 绑定，浏览器不能扩大权限，老师无权调用。支持按项目、原单状态、核销类型、提交日期或客户姓名＋生日查询；充值记录另返回作废申请状态，核销记录只显示原单审核状态。列表按 `(submitted_at,id)` 游标分页且每页最多 100 条，顶部统计由数据库对完整筛选范围汇总。部署前应依次完成迁移 `026`--`036`，并执行 `033_hq_query_indexes.sql` 支撑总部跨门店查询。
- `getStoreDashboard`：总部与门店共用的真实门店主页。门店账号始终按当前 CloudBase UID 锁定自身绑定门店；总部必须提交一个真实数字门店 ID，服务端验证门店存在后返回该门店基础资料、项目累计和分页客户数据。老师无权调用，浏览器传入的门店编号不能扩大门店账号权限。项目累计将体验明确独立（不扣客户余额），并返回退费生效前是否已有付费核销、退费实际扣掉的客户余额、余额不足而未扣余的退款、历史冲销、原始应计余额和按客户×项目归零后的调整，避免把不同客户的余额跨人抵扣。该动作依赖迁移 `021_customer_product_effective_balances.sql` 的客户余额汇总；生产环境建议同时执行迁移 `031_store_dashboard_indexes.sql`。
- `listActiveTeachers`：门店账号读取全部活跃老师；老师账号只能得到当前登录老师本人。老师办理页的老师下拉框由此锁定，浏览器不能把工单绑定给其他老师。
- `listActiveProducts`：允许活跃门店或已选择活跃门店的老师调用，只返回数据库中 `product_status='ACTIVE'` 产品的内部 ID、编号和名称；不会预取介绍、类别或任何价格字段。
- `createRechargeApplication`：只创建一张 `NEW`、`PENDING` 的真实充值单，并使用 `idempotency_key` 防止双击或网络重试重复建单。门店办理时业务老师可以为空；老师办理时服务端强制绑定当前登录老师，忽略空值并拒绝其他老师 ID。提交待审核单不会增加客户充值次数；只有审核把同一张单改为 `APPROVED` 后，数据库汇总触发器才会计入次数。部署前依次确认已执行迁移 `021_customer_product_effective_balances.sql`、`023_recharge_pending_submission.sql` 和 `024_optional_recharge_teacher.sql`。
- `createVerificationApplication`：门店与老师均支持正常及补录核销；老师必须先选择本次办理门店，服务端强制 `teacher_id` 为当前登录老师。两种身份均必须先确认目标门店活跃客户、有效余额并完成该客户的 1:1 人脸验证；服务端同时校验未过期、未消费、属于同一提交账号／门店／客户／人脸请求的照片令牌，并通过迁移 037／038 的数据库函数原子创建工单、固化客户留存照引用并绑定本次人脸照片。补录核销必须填写原因、写入 `PENDING` 并等待总部审核，不发送设备开启信号。
- `getTeacherWorkspace`：仅允许活跃老师读取本人基础资料和 `teacher_id` 等于本人的充值／核销工单。列表按 `(submitted_at,id)` 游标分批读取，每批最多 100 条；精确详情再次同时校验工单 ID、类型与当前老师。客户主页权限只由该老师已通过的正常／体验核销关系授予，不由充值、退费或浏览器参数授予。
- `getActiveStoreCustomerDetail`：客户在下拉框中被选中后才调用；重新确认客户仍为当前门店或老师所选门店的活跃客户，再返回办理流程需要的客户资料和私有照片短时签名地址。短时地址会在安全有效期内由页面与云函数温实例复用，避免重复签名和重复查询；每次返回前仍先执行当前登录身份和门店范围校验。
- `getCustomerProfile`：总部可读取任意客户、门店只可读取本门店客户；老师只可读取本人已有已通过正常／体验核销关系的客户。余额直接读取汇总表，充值与核销历史各自先返回最近 50 条，后续使用 `(submitted_at,id)` 游标每批最多 100 条，避免一次返回整段历史。
- `getReviewCustomerProfile`：已随运营角色下线；总部审核页直接使用 `getCustomerProfile` 与审核详情入口，不再提供运营审核上下文接口。
- `getCustomerPhotoUrl`：总部可读取任意客户、门店只可读取本门店客户；老师只可读取本人已有已通过正常／体验核销关系客户的照片。验证权限后为私有建档照片生成短时有效的签名地址。客户主页使用此动作，浏览器不能直接使用数据库中的 `pg://` 引用。
  - 兼容旧版本曾保存的重复桶名前缀（例如 `pg://bucket/bucket/path`）：读取时自动尝试两个合法对象名，成功后把数据库引用规范化。
  - 兼容 CloudBase `signObject` 的直接／包装返回结构；单对象接口未返回 URL 时自动使用 `signObjects` 复核，并继续尝试旧照片路径。
  - 若两个路径都不存在，返回 `CUSTOMER_PHOTO_OBJECT_MISSING`，该客户需要重新采集照片；不会把底层存储错误直接暴露给页面。
- `getCustomerProductBalances`：验证当前门店账号或老师所选门店和客户归属后，读取该客户按产品汇总的购买次数、有效核销次数和剩余次数；体验核销不消耗余额。核销不提供作废入口，如需纠正误核销必须提交充值工单补回次数。
- `getCustomerStatus`：总部可读取任意客户、门店只可读取本门店客户的资料与当前活跃／封存状态；返回客户姓名、生日、备注、建立时间，以及关联门店的真实名称和门店编号。
- `updateCustomerStatus`：总部或客户所属门店把同一客户档案在 `ACTIVE` 与 `ARCHIVED` 之间切换；只更新状态和更新时间，不删除照片、面容档案或历史工单。
- `getVerificationPhotos`：总部可查看全部核销照片，门店只能查看本店，老师只能查看本人绑定工单。一次仅返回最多 5 张短时缩略图（客户留存照、本次核销人脸照、3 张补充照）和服务端计算的上传权限；高清原图不在列表阶段签发，数据库也不保存任何签名地址。
- `getVerificationPhotoOriginalUrl`：用户实际点击后再次校验相同工单权限，复用或刷新该照片位的短时原图地址，并写入 `VIEW_ORIGINAL` 查看审计。
- `getVerificationPhotoExportData`：仅供当前工单导出使用；执行与原图查看相同的实时账号、工单权限和 `VIEW_ORIGINAL` 审计，然后由云函数使用服务端鉴权通道直接读取单张私有 JPEG，以最多 4 MB 的 Base64 返回，不依赖临时下载地址。网页优先复用本页已经加载或刚提交的原图 Blob，只有浏览器无法读取字节时才逐张调用该安全兜底；不要求公开存储桶，也不向未授权账号签发或代理照片。
- `beginVerificationPhotoUpload`：入参仅为 `recordId`、客户端幂等 `requestId`、照片位 `slot=2..4` 和压缩后 JPEG 的实际 `originalBytes`。服务端先验证当前登录账号确为工单提交人且仍在 24 小时内；新请求先按真实 `storage.buckets.id` 选择桶，再调用数据库原子函数建立／复用任务并取得单任务锁。每单数据库层最多一条 `UPLOADING`，跨标签页也不能同时传第二张；同一 `requestId` 重试返回同一任务，不重复计数。每单／提交人一小时最多建立 30 个新任务。当前网页在 `verificationPhoto v5` 调用该动作，固定收到 `uploadMode=FUNCTION`。
- `commitVerificationPhotoUpload`：`verificationPhoto v5` 要求网页发送 `recordId`、`requestId`、该次压缩 JPEG 和服务端绑定该请求／工单／提交人／照片位／字节／对象引用的短时 HMAC 证明。服务端只使用数据库请求中保存的对象引用和预期字节，不接受客户端桶、路径、尺寸或散列；它重新检查 JPEG、解析真实尺寸并计算 SHA-256，再由数据库函数锁定订单和请求，在同一事务中写照片、写审计并把任务改为 `COMMITTED`。本函数保留 DIRECT 兼容处理，但当前网页不使用。
- `cancelVerificationPhotoUpload`：入参为 `recordId`、`requestId`；仅提交人可取消自己的未提交任务。取消立刻释放“每单一个任务”锁，但对象等签名保守失效 3 小时后才由定时清理删除，防止迟到 PUT 复活孤儿文件。已经提交的任务不能撤回照片。
- `getVerificationPhotoUploadStatus`：入参为 `recordId`、`requestId`；仅提交人可读取，返回 `UPLOADING`／`COMMITTED`／`CANCELLED`／`EXPIRED` 及对象是否已经到达存储。用于断网或页面恢复，不签发查看权限，也不扩大工单范围。
- `verificationPhoto v5` 的 `originalUpload` 固定为 `null`，网页不得尝试 PUT；函数响应绝不包含 `CLOUDBASE_APIKEY` 或兼容变量 `CLOUDBASE_SERVICE_ROLE_KEY`，`thumbnailUpload` 固定为 `null`，因为缩略图由服务端图片处理生成。
- `uploadVerificationExtraPhoto`：仅用于“迁移 039 尚未执行”的旧版短时兼容。迁移 039 一旦存在，该旧入口立即返回 `PHOTO_UPLOAD_DIRECT_REQUIRED`，防止旧页面绕过单任务锁；它与受上传请求约束的新 `FUNCTION` 路径不是同一条路径，不可混用。
- v82 延续照片专用启动模式和动作白名单，不暴露任何老师人脸创建、补录、替换、回读、回滚、最终清理或体验核销比对动作。普通核销与老师赠送体验都只对所选客户执行 `VerifyFace` 1:1 比对；系统没有 `SearchPersons`／`searchCustomer` 1:N 入口。照片桶仍保持私有，所有列表、原图与导出读取仍先经过账号和工单权限校验。
- `cleanupVerificationPhotoDrafts`：平台 Timer 自动入口不接收业务参数或凭证，只在可信 SCF Timer 上清理过期未消费草稿；控制台手工入口仍使用恒定时间比较的专用随机凭证。两种入口都不删除已经绑定核销单的照片。

正式上线前还要提供客户授权记录、照片与人脸数据删除流程、访问审计，并确认腾讯云高精度静态活体服务已开通和计费。

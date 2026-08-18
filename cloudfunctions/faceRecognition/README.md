# faceRecognition 云函数

该函数仅在 CloudBase 后端运行，用于门店客户建档、照片质量检测、私有照片留存、人脸人员库录入和后续人员搜索。客户不需要提供身份证。

当前版本：`v51`

## 必需环境变量

- `FACE_SECRET_ID`
- `FACE_SECRET_KEY`
- `FACE_GROUP_ID=lusizhuoerdatabase`
- `CLOUDBASE_SERVICE_ROLE_KEY`：CloudBase PG 云存储的服务端 API Key，只能保存在云函数环境变量中。

不要把腾讯云密钥写入前端 JavaScript、README 或 GitHub。

## 推荐环境变量

- `FACE_QUALITY_THRESHOLD=70`：建档照片质量最低分。
- `FACE_MATCH_THRESHOLD=85`：1:N 人员搜索最低相似度（不用于已选客户核销）。
- `FACE_VERIFY_THRESHOLD=60`：已选客户 1:1 核销最低相似度；同时要求腾讯云 `IsMatch=true`。
- `FACE_MATCH_MARGIN=10`：第一候选与第二候选的最低分差，防止结果过于接近时误认。
- `FACE_MAX_YAW=20`
- `FACE_MAX_PITCH=20`
- `FACE_MAX_ROLL=15`
- `FACE_LIVENESS_ENABLED=false`：未开通高精度静态活体服务前保持 `false`；开通后改为 `true`。
- `FACE_LIVENESS_THRESHOLD=40`：腾讯云高精度静态活体推荐阈值。
- `CUSTOMER_PHOTO_BUCKET_ID=customer-photos`
- `CUSTOMER_PHOTO_URL_TTL_SECONDS=120`：核销／充值选择客户时，私有照片临时地址的有效秒数；允许 30--600 秒。
- `VERIFICATION_PHOTO_BUCKET_ID=verification-photos`：可选的核销证据专用私有 PG 存储桶。未创建该桶或该桶返回 `STORAGE_BUCKET_NOT_FOUND` 时，仅核销证据对象会自动回退到现有 `customer-photos` 私有桶，不影响 1:1 人脸验证。
- `VERIFICATION_PHOTO_URL_TTL_SECONDS=900`：核销缩略图和按需原图的签名地址有效秒数；允许 60--900 秒。默认 15 分钟以复用浏览器私有缓存，地址仍会过期且不会写入持久存储。
- `VERIFICATION_PHOTO_UPLOAD_TTL_SECONDS=600`：一次直传任务在业务层的有效秒数；允许 120--900 秒。到期后数据库拒绝提交并释放该核销单的单任务锁。CloudBase 上传签名本身的实际失效时间由存储服务控制，因此取消／过期对象要等创建满 3 小时后再做最终清理。
- `VERIFICATION_FACE_EVIDENCE_TTL_MINUTES=30`：人脸比对通过后、正式提交核销单前的照片草稿有效分钟；允许 5--120 分钟。
- `VERIFICATION_PHOTO_CLEANUP_TOKEN`：至少 32 位随机清理凭证，只放云函数环境变量和定时触发器事件中。

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
- `SearchPersons` 仅保留给明确需要 1:N 查人的场景，默认阈值 85，并检查前两名分差。
- 人脸结果只能用于找到候选客户，不能仅凭分数自动扣次；还要展示客户核心信息供员工核对。

## 云存储

- PG 存储桶：`customer-photos`
- 访问权限：私有
- 单文件限制：5 MB
- MIME 白名单：`image/jpeg`
- 对象路径：`<storeId>/<customerCode>/<timestamp>.jpg`

该桶不为 `anon` 或 `authenticated` 创建任何 RLS Policy，客户端访问默认拒绝；只有使用 `service_role` 的云函数可以读写。数据库保存 `pg://<bucketId>/<objectName>` 私有引用，不保存公开下载地址。

建议另建 PG 存储桶 `verification-photos` 以便分开管理和保留策略；该桶不存在时 v51 会自动使用现有的私有 `customer-photos` 桶：

- 访问权限：私有；不要给 `anon` 或 `authenticated` 添加 SELECT/INSERT/UPDATE/DELETE Policy。
- 单文件限制：5 MB；MIME 白名单仅 `image/jpeg`。
- CORS：只允许正式静态站点域名及本地测试域名；读取允许 `GET`／`HEAD`，直传允许 `PUT`，请求头只开放 `Content-Type`。不要使用 `*` 来源，也不要开放浏览器列桶、删除或覆盖权限。桶仍保持私有且不给 `anon`／`authenticated` 建 Policy；浏览器只能使用服务端为一个随机对象名签发的完整短时 URL。
- 对象路径：人脸凭证使用 `face-evidence/<store>/<staff>/<token>/...`，新版补充照片使用 `records/<verificationId>/slot-<n>/direct-<timestamp>-<server nonce>.jpg`；路径全部由云函数随机生成，浏览器输入不会进入路径，每次替换都使用新对象名且签名禁止覆盖。
- 每单固定展示客户建档留存照、本次核销人脸照和 3 个补充照片位。客户留存照引用在建单事务中固化；v51 的补充照片只直传一份高清 JPEG，提交时云函数读取私有对象并验证实际字节数、MIME、JPEG 文件头、真实尺寸和 SHA-256，缩略图由 CloudBase 图片处理按需生成。迁移 039 仍兼容旧版已经保存的“原图＋独立缩略图”。
- 原图和缩略图设置私有长期缓存；数据库从不保存签名 URL。详情首屏在完成账号和工单权限校验后，同时准备最多 5 张缩略图及短时原图地址；页面仅在非省流、非 2G 网络下提前解码前两个照片位，并把已解码原图限制为最多 2 张。点击时先显示缩略图，再无闪烁替换为高清图；同页重复查看可复用仍有效的私有地址，首次查看仍会在后台再次校验权限并写入查看审计。
- 创建一个每小时定时触发器调用 `{ "action":"cleanupVerificationPhotoDrafts", "cleanupToken":"与环境变量相同的随机值" }`，清除过期且未建单的人脸照片草稿，以及取消／过期的直传孤儿对象。一次最多各处理 100 组，可按返回值继续触发。直传对象至少等创建满 3 小时才删除，避免“取消后旧签名仍有效、迟到 PUT 在清理后重新产生永久孤儿”的竞态。

## 部署

把本目录中的 `index.js`、`package.json` 和 `README.md` 放在 ZIP 根目录上传。函数入口为 `index.main`，部署时安装 `package.json` 依赖。

直传上线必须安排一个短暂停写窗口，并严格按下列顺序部署，避免旧页面绕过单任务锁：

1. 在完整 PostgreSQL migration 工具中执行 `database/migrations/039_direct_verification_photo_upload.sql`；腾讯云 SQL 编辑器则依次单独执行 `039-01`、`039-02`、`039-03`、`039-04`、`039-05`。
2. 部署 `faceRecognition v51`。迁移 039 存在后，旧 `uploadVerificationExtraPhoto` Base64 写入口会返回 `PHOTO_UPLOAD_DIRECT_REQUIRED`，不能与直传并发覆盖。
3. 发布使用四阶段直传动作的静态前端，再结束停写窗口。

不要先发布新前端；它在迁移 039 缺失时会得到 `DATABASE_SCHEMA_MISSING`。也不要在 039 已执行后继续长期运行 v50，因为 v50 不认识上传任务锁。

部署后测试：

```json
{ "action": "health" }
```

应返回：

```json
{
  "ok": true,
  "version": "v51",
  "photoBucketId": "customer-photos",
  "verificationPhotoBucketId": "verification-photos",
  "verificationPhotoFallbackBucketId": "customer-photos",
  "verificationPhotoUrlTtlSeconds": 900,
  "verificationPhotoUploadTtlSeconds": 600,
  "verificationPhotoCleanupConfigured": true,
  "livenessEnabled": true
}
```

## 支持的动作

- `validateCapture`：拍照后立即检查单人、人脸尺寸、质量、口罩、闭眼和姿态。
- `registerCustomer`：服务端质量检查、可选活体检测，然后以新的唯一客户编号和 `PersonId` 入人员库、上传私有照片并写客户表。同一张脸、相同姓名或相同生日都允许建立新的独立客户档案。
- `getTeacherBusinessContext`：仅允许活跃老师账号调用，返回当前老师本人身份和可选择的活跃门店。老师必须先选择本次办理门店，后续每个业务动作都会由服务端重新校验老师身份与门店状态。
- `listActiveStoreCustomers`：门店账号按 UID 锁定自身门店；老师账号必须提交一个真实活跃门店 ID。只返回目标门店 `customer_status='ACTIVE'` 客户的编号、姓名和生日。初始下拉最多返回 100 位，更多客户使用姓名＋生日在服务端精确查询；不会预取备注、状态或业务汇总。
- `queryStoreCustomers`：总部与门店共用的真实客户查询。服务端先根据 CloudBase UID 验证活跃身份；总部可查看全部门店或选择一个真实门店，门店账号始终锁定到自身绑定门店，运营和老师无权调用。结果使用 `(created_at,id)` 游标分页且每页最多 100 条，业务阶段、活跃／封存及总数均由数据库对完整筛选范围汇总。
- `queryStoreBusinessRecords`：总部与门店共用的充值／核销查询。总部可查看全部门店或选择一个真实门店；门店范围只来自服务端 UID 绑定，浏览器不能扩大权限，运营和老师无权调用。支持按项目、原单状态、核销类型、提交日期或客户姓名＋生日查询；充值记录另返回作废申请状态，核销记录只显示原单审核状态。列表按 `(submitted_at,id)` 游标分页且每页最多 100 条，顶部统计由数据库对完整筛选范围汇总。部署前应依次完成迁移 `026`--`036`，并执行 `033_hq_query_indexes.sql` 支撑总部跨门店查询。
- `getStoreDashboard`：总部与门店共用的真实门店主页。门店账号始终按当前 CloudBase UID 锁定自身绑定门店；总部必须提交一个真实数字门店 ID，服务端验证门店存在后返回该门店基础资料、项目累计、老师核销和分页客户数据。运营和老师无权调用，浏览器传入的门店编号不能扩大门店账号权限。该动作依赖迁移 `021_customer_product_effective_balances.sql` 的客户余额汇总；生产环境建议同时执行迁移 `031_store_dashboard_indexes.sql`。
- `listActiveTeachers`：门店账号读取全部活跃老师；老师账号只能得到当前登录老师本人。老师办理页的老师下拉框由此锁定，浏览器不能把工单绑定给其他老师。
- `listActiveProducts`：允许活跃门店或已选择活跃门店的老师调用，只返回数据库中 `product_status='ACTIVE'` 产品的内部 ID、编号和名称；不会预取介绍、类别或任何价格字段。
- `createRechargeApplication`：只创建一张 `NEW`、`PENDING` 的真实充值单，并使用 `idempotency_key` 防止双击或网络重试重复建单。门店办理时业务老师可以为空；老师办理时服务端强制绑定当前登录老师，忽略空值并拒绝其他老师 ID。提交待审核单不会增加客户充值次数；只有审核把同一张单改为 `APPROVED` 后，数据库汇总触发器才会计入次数。部署前依次确认已执行迁移 `021_customer_product_effective_balances.sql`、`023_recharge_pending_submission.sql` 和 `024_optional_recharge_teacher.sql`。
- `createVerificationApplication`：门店与老师均支持正常及补录核销；老师必须先选择本次办理门店，服务端强制 `teacher_id` 为当前登录老师。两种身份均必须先确认目标门店活跃客户、有效余额并完成该客户的 1:1 人脸验证；服务端同时校验未过期、未消费、属于同一提交账号／门店／客户／人脸请求的照片令牌，并通过迁移 037／038 的数据库函数原子创建工单、固化客户留存照引用并绑定本次人脸照片。补录核销必须填写原因、写入 `PENDING` 并等待总部或运营审核，不发送设备开启信号。
- `getTeacherWorkspace`：仅允许活跃老师读取本人基础资料和 `teacher_id` 等于本人的充值／核销工单。列表按 `(submitted_at,id)` 游标分批读取，每批最多 100 条；精确详情再次同时校验工单 ID、类型与当前老师。响应中的客户只作为工单文字上下文，不授予客户主页、照片、查询或状态修改权限。
- `getActiveStoreCustomerDetail`：客户在下拉框中被选中后才调用；重新确认客户仍为当前门店或老师所选门店的活跃客户，再返回办理流程需要的客户资料和私有照片短时签名地址。短时地址会在安全有效期内由页面与云函数温实例复用，避免重复签名和重复查询；每次返回前仍先执行当前登录身份和门店范围校验。
- `getCustomerProfile`：总部可读取任意客户、门店只可读取本门店客户；运营和老师不能调用该常规客户主页入口。余额直接读取汇总表，充值与核销历史各自先返回最近 50 条，后续使用 `(submitted_at,id)` 游标每批最多 100 条，避免一次返回整段历史。
- `getReviewCustomerProfile`：仅活跃运营审核账号可调用，并且必须同时提交审核工单类型和数据库工单 ID。服务端验证该充值或补录核销审核工单确实属于目标客户后，才返回只读客户资料、余额与业务历史；缺少上下文、客户不匹配、普通／体验／历史作废核销均拒绝。该动作不返回客户照片，也不能修改客户状态。
- `getCustomerPhotoUrl`：总部可读取任意客户、门店只可读取本门店客户；运营和老师无权访问客户照片。验证权限后为私有建档照片生成短时有效的签名地址。客户主页使用此动作，浏览器不能直接使用数据库中的 `pg://` 引用。
  - 兼容旧版本曾保存的重复桶名前缀（例如 `pg://bucket/bucket/path`）：读取时自动尝试两个合法对象名，成功后把数据库引用规范化。
  - 兼容 CloudBase `signObject` 的直接／包装返回结构；单对象接口未返回 URL 时自动使用 `signObjects` 复核，并继续尝试旧照片路径。
  - 若两个路径都不存在，返回 `CUSTOMER_PHOTO_OBJECT_MISSING`，该客户需要重新采集照片；不会把底层存储错误直接暴露给页面。
- `getCustomerProductBalances`：验证当前门店账号或老师所选门店和客户归属后，读取该客户按产品汇总的购买次数、有效核销次数和剩余次数；体验核销不消耗余额。核销不提供作废入口，如需纠正误核销必须提交充值工单补回次数。
- `getCustomerStatus`：总部可读取任意客户、门店只可读取本门店客户的资料与当前活跃／封存状态；返回客户姓名、生日、备注、建立时间，以及关联门店的真实名称和门店编号。
- `updateCustomerStatus`：总部或客户所属门店把同一客户档案在 `ACTIVE` 与 `ARCHIVED` 之间切换；只更新状态和更新时间，不删除照片、面容档案或历史工单。
- `searchCustomer`：质量检查、可选活体检测、人员搜索、阈值和候选分差判断，再从本门店客户表返回档案。
- `getVerificationPhotos`：总部可查看全部核销照片，门店只能查看本店，老师只能查看本人绑定工单，运营只能查看审核范围内的补录核销。一次返回最多 5 张短时缩略图、同期限原图地址（客户留存照、本次核销人脸照、3 张补充照）和服务端计算的上传权限；所有地址仅在本次权限校验通过后签发，数据库不保存签名地址。
- `getVerificationPhotoOriginalUrl`：用户实际点击后再次校验相同工单权限，复用或刷新该照片位的短时原图地址，并写入 `VIEW_ORIGINAL` 查看审计。
- `getVerificationPhotoExportData`：仅供当前工单导出使用；先复用 `getVerificationPhotoOriginalUrl` 的实时账号、工单权限和查看审计，再由云函数通过 HTTPS 读取单张私有 JPEG，以最多 4 MB 的 Base64 返回。网页优先复用已经加载的原图缓存，只有浏览器因私有桶 CORS／临时地址失效而无法读取字节时才逐张调用该安全兜底；不要求公开存储桶，也不向未授权账号签发或代理照片。
- `beginVerificationPhotoUpload`：入参仅为 `recordId`、客户端幂等 `requestId`、照片位 `slot=2..4` 和压缩后 JPEG 的实际 `originalBytes`。服务端先验证当前登录账号确为工单提交人且仍在 24 小时内，再生成随机对象路径和完整预签名 PUT URL。每单数据库层最多一条 `UPLOADING`，跨标签页也不能同时传第二张；同一 `requestId` 重试返回同一任务，不重复计数。每单／提交人一小时最多建立 30 个新任务。
- `commitVerificationPhotoUpload`：入参只有 `recordId` 和 `requestId`。云函数用 `getObjectInfoAuthenticated` 核对对象路径、桶、MIME 和预期字节，再读取最多 3 MB 原图检查 JPEG、解析真实尺寸并计算 SHA-256；数据库函数重新锁订单和请求，在同一事务中写照片、写审计并把任务改为 `COMMITTED`。客户端传入的尺寸、散列和对象路径一律不采信。
- `cancelVerificationPhotoUpload`：入参为 `recordId`、`requestId`；仅提交人可取消自己的未提交任务。取消立刻释放“每单一个任务”锁，但对象等签名保守失效 3 小时后才由定时清理删除，防止迟到 PUT 复活孤儿文件。已经提交的任务不能撤回照片。
- `getVerificationPhotoUploadStatus`：入参为 `recordId`、`requestId`；仅提交人可读取，返回 `UPLOADING`／`COMMITTED`／`CANCELLED`／`EXPIRED` 及对象是否已经到达存储。用于断网或页面恢复，不签发查看权限，也不扩大工单范围。
- 直传响应中的 `originalUpload.url` 已包含短时上传 token。浏览器只需对完整 URL 发 `PUT`，请求体为 JPEG Blob，并使用返回的 `headers: { "Content-Type": "image/jpeg" }`；不要再把 token 放进 Authorization、自定义 header 或 query。响应绝不包含 `CLOUDBASE_SERVICE_ROLE_KEY`。`thumbnailUpload` 固定为 `null`，因为缩略图由服务端图片处理生成。
- `uploadVerificationExtraPhoto`：仅用于“v51 已部署但迁移 039 尚未执行”的短时兼容。迁移 039 一旦存在，该旧 Base64 入口立即返回 `PHOTO_UPLOAD_DIRECT_REQUIRED`，防止旧页面绕过单任务锁；不可把它当作长期回退路径。
- v51 保留 v50 的私有读取、缓存和签名兼容处理；新增单对象直传、可取消任务、服务端内容检查和数据库原子提交。照片桶仍保持私有，所有列表、原图与导出读取仍先经过账号和工单权限校验。
- `cleanupVerificationPhotoDrafts`：定时触发器使用恒定时间比较的专用随机凭证清理过期未消费草稿；不删除已经绑定核销单的照片。

正式上线前还要提供客户授权记录、照片与人脸数据删除流程、访问审计，并确认腾讯云高精度静态活体服务已开通和计费。

# verificationPhoto 云函数

当前版本：`v11`（共享照片服务实现 `v10`）

该函数专门处理核销单的五个照片位：列表与缩略图、按需读取高清原图、导出原图，以及三个补充照片位的开始、提交、状态恢复和取消。它不执行质量检测、活体检测、客户建档或人脸比对，也不暴露这些动作。老师本人创建客户，或作为来源可信的有效工单 `teacher_id` 与客户建立业务关系后，可以只读查看该客户的其他核销照片；来源必须是门店提交或提交老师账号与 `teacher_id` 为同一人，总部、退役角色和老师错绑旧字段本身不授予照片权。上传、替换和取消仍只允许真实原提交账号 `submitted_by_account_id`。

补充照片复用迁移 039 的单任务锁、提交人权限和 24 小时截止规则。v11 固定采用签名直传：服务端先建立数据库任务并锁定随机私有对象，再只向有权提交账号返回该对象的一次性 HTTPS PUT 地址；网页或小程序把本地 JPEG 原始字节直接上传到存储，随后只把 `recordId` 和 `requestId` 提交给函数。函数从同一对象读取真实内容，重新校验桶、路径、字节数、JPEG 文件头、尺寸和 SHA-256 后原子绑定工单。CloudBase Manager 5.6.4 的相对签名路由只按当前环境 ID 补全到可信 HTTPS 网关，并核对精确桶和对象路径。旧的 Base64／`callFunction` 照片字节中转已退役，独立服务收到 `imageBase64` 会返回 `PHOTO_DIRECT_UPLOAD_REQUIRED`。

总部、门店或老师只有在当前登录账号就是工单原提交账号、且服务器时间仍早于 `submitted_at + 24 hours` 时才能上传或替换；不同总部账号也不能互相代传。已下线的历史运营身份不能登录、查看或写入。签名失败时服务端会精确取消刚建立的任务，不能遗留进行中锁；客户端上传失败时也按原请求状态确认后取消。照片仍保持私有；一次性地址只授权任务绑定的随机对象，不公开桶，也不把 service-role Key 返回客户端。列表、原图、导出和写入均先校验当前登录账号与工单权限。

## 为什么拆成独立函数

- 包内不安装 `tencentcloud-sdk-nodejs`，照片请求不会初始化人脸 SDK，依赖更小、冷启动路径更短。
- 照片查看、导出和上传流量不会挤占建档与 1:1 人脸核验函数的温实例。
- `faceRecognition` 继续负责客户、工单和人脸流程；本函数只接受下面列出的照片动作，不能代替人脸识别。

拆分函数无法改变用户网络上传 JPEG 所需的带宽。页面仍会先把照片压到不超过 3 MB 的高质量 JPEG，并且同一张核销单只允许一个进行中的补充照片任务；第一张成功、权威失败或服务器确认取消后，才可开始下一张。

## 创建函数

- CloudBase 函数名称必须精确填写：`verificationPhoto`
- 运行时：与现有 `faceRecognition` 相同的受支持 Node.js 运行时
- 入口：`index.main`
- 内存：`512 MB`
- 超时：`60 秒`
- 并发／实例：先使用平台默认值；如果监控确认主要延迟来自冷启动，可为生产版本配置 `1` 个预置并发实例。预置实例持续计费，不要在没有监控证据时盲目增加。

最终 `verificationPhoto-v11.zip` 的根目录必须是：

```text
index.js      # 由本目录 deploy-index.js 复制并改名
service.js    # 由 ../faceRecognition/index.js 复制
read-reliability.js # 私有照片签名重试、并发去重与安全读取回退
package.json
README.md
```

不要把源码树中的 `index.js` 单独放进 ZIP；它使用 `../faceRecognition/index.js`，只用于本地源码与测试。必须把本目录的 `read-reliability.js` 原样放在 ZIP 根目录。不要把整个 `faceRecognition` 目录或它的 `node_modules` 复制进包；部署时让 CloudBase 按本函数的 `package.json` 安装依赖。

读取适配层不会自行查询账号或绕过权限。列表、原图和导出仍先进入共享服务完成登录、工单范围校验与原图查看审计；适配层只对底层签名的瞬时 `InternalError` 做最多三次带抖动的有界重试，并把同一对象正在进行的并发签名合并为一次。适配层不再二次缓存已完成的签名，避免把短效地址重新包装成长有效期；共享服务只按地址实际剩余时间复用。v11 的首屏清单不再因为某张缩略图签名失败而继续批量读取其原图地址或原图字节：数据库声明存在但缩略图暂不可用的照片只返回该位置的 `thumbnailRetryable` 与 `getVerificationPhotoThumbnailData`。客户端点击哪张照片，就只让该照片再次经过权限校验并读取安全原图字节，其他已显示照片和照片位不刷新。原图预览本身的签名不可用或已过期时仍会再次通过共享的授权导出动作返回内联 JPEG。因此这些按需回退不依赖照片桶的浏览器读取 CORS，也不会向未授权请求返回 URL 或 Base64。

## 必需环境变量

```text
CLOUDBASE_ENV_ID=rusizhuoer-d9gbcsgym07651694
CLOUDBASE_APIKEY=<平台托管的同一 CloudBase 环境 service-role API Key>
CUSTOMER_PHOTO_BUCKET_ID=customer-photos
VERIFICATION_PHOTO_BUCKET_ID=customer-photos
VERIFICATION_PHOTO_CLEANUP_TOKEN=<至少 32 个随机字符，两个函数保持相同>
```

优先使用平台托管变量 `CLOUDBASE_APIKEY`。代码仍兼容旧变量 `CLOUDBASE_SERVICE_ROLE_KEY`，但两者同时存在时只使用 `CLOUDBASE_APIKEY`。service-role Key 只能放在云函数环境变量中，不能写入网页、GitHub、ZIP、日志或截图；Key、环境 ID、PostgreSQL 实例和照片桶必须全部属于同一个 CloudBase 环境。

`verificationPhoto` 与 `faceRecognition` 必须在各自函数的环境变量页面分开配置；每个变量名称和值各占一行／一个输入项。不要把整段 `KEY=value` 文本、其他变量名、引号或换行一起粘进某一个变量值。两个函数使用同一个安全随机、至少 32 位的 `VERIFICATION_PHOTO_CLEANUP_TOKEN`，但该值只存在环境变量中，不写进 triggers-only 配置。

当前环境已经使用私有桶 `customer-photos`，不需要为了本函数新建桶。只有计划单独管理核销照片的生命周期时，才把 `VERIFICATION_PHOTO_BUCKET_ID` 改成已创建的私有桶 `verification-photos`；不能只改变量而不创建真实桶。

## 推荐环境变量

```text
VERIFICATION_PHOTO_URL_TTL_SECONDS=900
VERIFICATION_PHOTO_UPLOAD_TTL_SECONDS=600
```

- `VERIFICATION_PHOTO_URL_TTL_SECONDS`：核销缩略图／原图短时读取地址，允许 60--900 秒。
- `VERIFICATION_PHOTO_UPLOAD_TTL_SECONDS`：一项补充照片上传任务的业务有效期，允许 120--900 秒。
`VERIFICATION_PHOTO_CLEANUP_TOKEN` 仅用于控制台／管理端手工补跑清理，不写入定时触发器配置。应使用密码管理器或安全随机生成器创建，至少 32 个随机字符，不要使用示例文本。普通登录客户端即使获得该值也会被函数拒绝。

本函数不需要也不要配置 `CUSTOMER_PHOTO_URL_TTL_SECONDS`、`VERIFICATION_FACE_EVIDENCE_TTL_MINUTES`、`FACE_SECRET_ID`、`FACE_SECRET_KEY`、`FACE_GROUP_ID`、`FACE_LIVENESS_*`、`FACE_QUALITY_THRESHOLD`、`FACE_VERIFY_THRESHOLD` 或任何其他客户照片 URL／人脸草稿／阈值变量。前两个变量只保留在 `faceRecognition`；照片专用函数会读取工单已经固化的客户留存照引用，但不调用常规客户照片 URL 接口，也不创建或清理正式建单前的人脸照片草稿。

## 客户端调用权限

在当前 CloudBase 环境的**云函数安全规则**中，把下面这个函数级成员合并到现有顶层规则对象；这里只展示要合并的成员，不是可覆盖整份规则的完整文件：

```text
"verificationPhoto": {
  "invoke": "auth.loginType != 'ANONYMOUS' && auth != null"
}
```

必须保留现有顶层 `"*"` 条目和其他函数条目，不要用上面的片段替换整份安全规则。该规则允许已登录网页通过 `callFunction` 调用照片函数，匿名或无会话请求仍被平台拒绝；出现 `EXCEED_AUTHORITY` 时先确认这条成员已经合并、当前账号不是匿名登录且会话没有过期。Timer 由平台触发器调用，不走普通客户端 `invoke` 授权；函数内部仍会单独验证可信 Timer 来源。

## 存储与数据库前置条件

生产库已经成功执行迁移 039 时不要重跑 037、038 或 039，但必须确认已执行一次迁移 040；040 仅修复 `commit_verification_photo_upload` 中 `photo_slot` 的 PL/pgSQL 歧义，不改表或现有照片数据。部署前在同一个 CloudBase PostgreSQL 环境执行只读检查：

```sql
SELECT
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

应看到非空 `upload_request_table`、`configured_bucket_exists=true`，以及一行私有 `customer-photos`。共享桶的 `file_size_limit` 至少为 `5242880`（5 MB），`allowed_mime_types` 为空或包含 `image/jpeg`。桶保持私有，不给 `anon`／`authenticated` 创建整桶读写 Policy。Web 安全域名和存储 CORS 只放行实际生产站点对 `PUT`、`GET`、`HEAD` 的需要，不使用 `*` 扩大来源；小程序还必须把实际签名地址所属 HTTPS 域名配置为 `request` 合法域名。一次性地址本身只允许写入服务端预先选定的随机对象。

## 支持的动作

- `health`
- `getVerificationPhotos`
- `getVerificationPhotoOriginalUrl`
- `getVerificationPhotoExportData`
- `getVerificationPhotoThumbnailData`（签名地址和原图地址均不可用时，单张按需安全字节回退）
- `beginVerificationPhotoUpload`
- `getVerificationPhotoUploadStatus`
- `cancelVerificationPhotoUpload`
- `commitVerificationPhotoUpload`
- `cleanupVerificationPhotoUploads`

`beginVerificationPhotoUpload` 固定返回 `uploadMode: "DIRECT"`、一次性 `originalUpload` PUT 地址和预期字节数，不返回 service-role Key。`commitVerificationPhotoUpload` 只接收请求身份，不接收照片 Base64、客户端桶、路径、尺寸、散列或 MIME 元数据；服务端读取任务绑定的真实对象并通过迁移 039 原子提交。任何人脸、客户、充值或建单动作都会返回 `ACTION_NOT_FOUND`。

## 定时清理

在 `verificationPhoto` 的触发器配置编辑器中填写以下完整配置。CloudBase 只接受顶层 `triggers` 数组；这里不能填写业务事件、`action` 或 `cleanupToken`：

```json
{
  "triggers": [
    {
      "name": "cleanup-verification-photo-uploads-hourly",
      "type": "timer",
      "config": "0 10 * * * * *"
    }
  ]
}
```

该七段 Cron 在每小时第 10 分钟运行，与 `faceRecognition` 的整点清理错峰。v11 继续由共享业务实现验证 SCF 保留变量 `TRIGGER_SRC=timer`、平台函数名、事件类型、精确触发器名、时间格式和“无终端用户 UID”，普通客户端伪造 `Type: Timer` 或触发器名不能进入清理。它只清理迁移 039 中已经取消或过期、且超过安全等待期的补充照片上传对象；已绑定工单的照片不会删除。原 `faceRecognition` 的人脸草稿触发器使用另一个固定名称，两个配置不要互换。

控制台需要手工补跑时才使用以下测试事件，并确保调用没有终端用户 UID：

```json
{
  "action": "cleanupVerificationPhotoUploads",
  "cleanupToken": "与环境变量 VERIFICATION_PHOTO_CLEANUP_TOKEN 完全一致的真实值"
}
```

## 部署顺序与健康检查

1. 确认迁移 039 表和真实桶均存在，并已执行完整的 `046_teacher_face_and_experience_quotas.sql`（CloudBase SQL 编辑器为 `046-01` 至 `046-08`）。
2. 部署当前 `faceRecognition-v111.zip` 与 `staffAccount-v81.zip`，分别调用 `health` 确认 `v111`、`v81`。在仅限总部使用、已加载当前 `cloudbase-phone-auth.js` 的临时维护页面中，以已登录总部身份执行 `await CloudBasePhoneAuth.retireOperationAccounts()`；必须等待成功封锁旧运营账号的 CloudBase 凭据。该维护页不是最终静态发布。
3. 只有该总部维护动作成功后，才在 CloudBase SQL 编辑器依次执行 `047-01-retire-operation-accounts.sql`、`047-02-hq-reviewer-guard.sql`。它保留历史业务和审核外键，但永久封存旧运营身份并将审核收紧为总部独占。
4. 依次执行并验收 049、050；部署不再读写旧 Saga 的 `faceRecognition v111`、`staffAccount v81` 和 `teacherCreate v6` 后执行 053 并确认 7 行全部 `RETIRED`。继续依次执行并验收 054—067；删除旧 `reconcile-teacher-face-operations` Timer，保留老师额度月初 Timer。
5. 新建或更新函数 `verificationPhoto`，上传 `verificationPhoto-v11.zip`，配置上述环境变量、512 MB 内存和 60 秒超时。
6. 对 `verificationPhoto` 调用 `{ "action": "health" }`，确认 `version: "v11"`、`sharedVersion: "v10"`、`uploadMode: "DIRECT"` 与全部就绪字段，再保存本节的 triggers-only 配置。
7. 评价同轮还必须执行并验收 068、配置至少 32 字节的 `CUSTOMER_RATING_SIGNING_KEY` 及实际 `rating.html` 地址 `CUSTOMER_RATING_BASE_URL`、上传 `customerRating-v6.zip` 并确认 `health` 为 `v6` 且 `configured=true`。`verificationPhoto v11` 不读取或写入评价。
8. 只有相关函数均验证成功后，才发布包含 `rating.html` 的当前静态前端并强制刷新浏览器；不要先发前端。

`verificationPhoto` 应返回类似：

```json
{
  "ok": true,
  "ready": true,
  "version": "v11",
  "sharedVersion": "v10",
  "service": "verificationPhoto",
  "uploadMode": "DIRECT",
  "photoBucketId": "customer-photos",
  "verificationPhotoBucketId": "customer-photos",
  "verificationPhotoFallbackBucketId": "customer-photos",
  "verificationPhotoUrlTtlSeconds": 900,
  "verificationPhotoUploadTtlSeconds": 600,
  "verificationPhotoCleanupConfigured": true,
  "verificationPhotoCleanupTimerTriggerName": "cleanup-verification-photo-uploads-hourly",
  "verificationPhotoServiceRoleKeyConfigured": true,
  "verificationPhotoUploadSchemaReady": true,
  "verificationPhotoBucketMetadataReady": true,
  "verificationPhotoServiceRoleStorageReady": true,
  "verificationPhotoReadReliability": {
    "signedUrlExpiryAware": true,
    "sameObjectFlightDeduplication": true,
    "maxSigningAttempts": 3,
    "maxSigningConcurrency": 6,
    "thumbnailDataFallback": true,
    "manifestFallbackDeferred": true,
    "perPhotoRetryIsolated": true
  }
}
```

若 `ready`、任一 `Ready` 字段、`verificationPhotoCleanupConfigured` 或 `verificationPhotoServiceRoleKeyConfigured` 为 `false`，先修复环境 ID、服务端 Key、清理凭证、迁移 039 或桶配置，保存同一响应中的错误码和请求 ID，不要用公开桶或整桶 Policy 绕过错误。

部署后至少用真实总部、门店和老师账号验证：总部没有任何业务办理入口且直接创建调用返回 `FORBIDDEN`，门店和老师仍可在各自权限内建立客户与办理业务，老师工单老师锁定为本人；有权账号可查看核销照片；只有历史总部单或当前门店／老师单中的真实原提交账号且在 `submitted_at + 24 hours` 内可写；其他总部账号、其他角色账号和超时请求被拒绝；历史运营账号必须无法登录或读取任何照片／客户／审核上下文；取消后可重新选择；一张成功后才可开始下一张；刷新后已提交照片仍可见；五张齐全时 PDF／图片导出不缺图。

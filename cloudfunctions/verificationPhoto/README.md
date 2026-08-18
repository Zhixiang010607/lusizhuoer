# verificationPhoto 云函数

当前版本：`v2`

该函数专门处理核销单的五个照片位：列表与缩略图、按需读取高清原图、导出原图，以及三个补充照片位的开始、提交、状态恢复和取消。它不执行质量检测、活体检测、客户建档或人脸比对，也不暴露这些动作。

补充照片复用迁移 039 的单任务锁、提交人权限和 24 小时截止规则，但照片内容固定通过 CloudBase `callFunction` 传给本函数，由服务端写入数据库任务已经锁定的随机对象。总部、门店或老师只有在当前登录账号就是工单原提交账号、且服务器时间仍早于 `submitted_at + 24 hours` 时才能上传或替换；不同总部账号也不能互相代传，运营始终无写权限。浏览器不再请求 PG 云存储 PUT 签名，因此不依赖照片桶的浏览器 PUT CORS，也不会再次遇到签名端点的 `STORAGE_INVALID_REQUEST`。照片仍保持私有；列表、原图、导出和写入均先校验当前登录账号与工单权限。

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

最终 `verificationPhoto-v2.zip` 的根目录必须是：

```text
index.js      # 由本目录 deploy-index.js 复制并改名
service.js    # 由 ../faceRecognition/index.js 复制
package.json
README.md
```

不要把源码树中的 `index.js` 单独放进 ZIP；它使用 `../faceRecognition/index.js`，只用于本地源码与测试。不要把整个 `faceRecognition` 目录或它的 `node_modules` 复制进包；部署时让 CloudBase 按本函数的 `package.json` 安装依赖。

## 必需环境变量

```text
CLOUDBASE_ENV_ID=rusizhuoer-d9gbcsgym07651694
CLOUDBASE_SERVICE_ROLE_KEY=<同一 CloudBase 环境的服务端 API Key>
CUSTOMER_PHOTO_BUCKET_ID=customer-photos
VERIFICATION_PHOTO_BUCKET_ID=customer-photos
VERIFICATION_PHOTO_CLEANUP_TOKEN=<至少 32 个随机字符，两个函数保持相同>
```

`CLOUDBASE_SERVICE_ROLE_KEY` 只能放在云函数环境变量中，不能写入网页、GitHub、ZIP、日志或截图。该 Key、环境 ID、PostgreSQL 实例和照片桶必须全部属于同一个 CloudBase 环境。

当前环境已经使用私有桶 `customer-photos`，不需要为了本函数新建桶。只有计划单独管理核销照片的生命周期时，才把 `VERIFICATION_PHOTO_BUCKET_ID` 改成已创建的私有桶 `verification-photos`；不能只改变量而不创建真实桶。

## 推荐环境变量

```text
VERIFICATION_PHOTO_URL_TTL_SECONDS=900
VERIFICATION_PHOTO_UPLOAD_TTL_SECONDS=600
```

- `VERIFICATION_PHOTO_URL_TTL_SECONDS`：核销缩略图／原图短时读取地址，允许 60--900 秒。
- `VERIFICATION_PHOTO_UPLOAD_TTL_SECONDS`：一项补充照片上传任务的业务有效期，允许 120--900 秒。
`VERIFICATION_PHOTO_CLEANUP_TOKEN` 是取消／过期上传的必需清理凭证。应使用密码管理器或安全随机生成器创建，至少 32 个随机字符，不要使用示例文本。

本函数不需要也不要配置 `CUSTOMER_PHOTO_URL_TTL_SECONDS`、`VERIFICATION_FACE_EVIDENCE_TTL_MINUTES`、`FACE_SECRET_ID`、`FACE_SECRET_KEY`、`FACE_GROUP_ID`、`FACE_LIVENESS_*`、`FACE_QUALITY_THRESHOLD`、`FACE_VERIFY_THRESHOLD` 或任何其他客户照片 URL／人脸草稿／阈值变量。前两个变量只保留在 `faceRecognition`；照片专用函数会读取工单已经固化的客户留存照引用，但不调用常规客户照片 URL 接口，也不创建或清理正式建单前的人脸照片草稿。

## 存储与数据库前置条件

本次总部共享办理与 v54／v2 更新不新增 SQL。生产库已经成功执行迁移 039 时，不要重跑 037、038 或 039。部署前在同一个 CloudBase PostgreSQL 环境执行只读检查：

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

应看到非空 `upload_request_table`、`configured_bucket_exists=true`，以及一行私有 `customer-photos`。共享桶的 `file_size_limit` 至少为 `5242880`（5 MB），`allowed_mime_types` 为空或包含 `image/jpeg`。桶保持私有，不给 `anon`／`authenticated` 创建整桶读写 Policy。照片通过云函数传输后，浏览器上传不要求桶开放 `PUT` CORS；静态站点仍需加入 CloudBase Web 安全域名，浏览器显示签名缩略图／原图所需的读取配置保持现状。

## 支持的动作

- `health`
- `getVerificationPhotos`
- `getVerificationPhotoOriginalUrl`
- `getVerificationPhotoExportData`
- `beginVerificationPhotoUpload`
- `getVerificationPhotoUploadStatus`
- `cancelVerificationPhotoUpload`
- `commitVerificationPhotoUpload`
- `cleanupVerificationPhotoUploads`

`beginVerificationPhotoUpload` 固定返回 `uploadMode: "FUNCTION"` 和与数据库请求绑定的短时证明，不返回浏览器 PUT 地址。`commitVerificationPhotoUpload` 必须携带该请求对应的 JPEG 与证明；服务端重新校验真实字节、JPEG 内容、尺寸和 SHA-256，然后通过迁移 039 原子提交。任何人脸、客户、充值或建单动作都会返回 `ACTION_NOT_FOUND`。

## 定时清理

在 `verificationPhoto` 上创建每小时一次的定时触发器，事件为：

```json
{
  "action": "cleanupVerificationPhotoUploads",
  "cleanupToken": "与 VERIFICATION_PHOTO_CLEANUP_TOKEN 完全相同的值"
}
```

它只清理迁移 039 中已经取消或过期、且超过安全等待期的补充照片上传对象。原 `faceRecognition` 的人脸草稿清理触发器仍保留，并继续调用 `cleanupVerificationPhotoDrafts`；不要把两个触发动作互换。

## 部署顺序与健康检查

1. 确认迁移 039 表和真实桶均存在。
2. 部署 `faceRecognition-v54.zip`，调用 `health` 确认 `version: "v54"`，并先验证原有建档、活体、1:1 核销人脸和总部四个共享办理入口。
3. 新建或更新函数 `verificationPhoto`，上传 `verificationPhoto-v2.zip`，配置上述环境变量、512 MB 内存和 60 秒超时。
4. 对 `verificationPhoto` 调用 `{ "action": "health" }`，确认 `version: "v2"` 与全部就绪字段。
5. 只有两个函数均验证成功后，才发布当前静态前端并强制刷新浏览器；不要先发前端。

`verificationPhoto` 应返回类似：

```json
{
  "ok": true,
  "ready": true,
  "version": "v2",
  "service": "verificationPhoto",
  "uploadMode": "FUNCTION",
  "photoBucketId": "customer-photos",
  "verificationPhotoBucketId": "customer-photos",
  "verificationPhotoFallbackBucketId": "customer-photos",
  "verificationPhotoUrlTtlSeconds": 900,
  "verificationPhotoUploadTtlSeconds": 600,
  "verificationPhotoCleanupConfigured": true,
  "verificationPhotoServiceRoleKeyConfigured": true,
  "verificationPhotoUploadSchemaReady": true,
  "verificationPhotoBucketMetadataReady": true,
  "verificationPhotoServiceRoleStorageReady": true
}
```

若 `ready`、任一 `Ready` 字段、`verificationPhotoCleanupConfigured` 或 `verificationPhotoServiceRoleKeyConfigured` 为 `false`，先修复环境 ID、服务端 Key、清理凭证、迁移 039 或桶配置，保存同一响应中的错误码和请求 ID，不要用公开桶或整桶 Policy 绕过错误。

部署后至少用真实总部、运营、门店和老师账号验证：总部四个办理入口必须先确认唯一 `ACTIVE` 门店且没有“全部门店”，运营没有办理入口，老师没有客户建立且工单老师锁定为本人；有权账号可查看核销照片；只有总部／门店／老师中的真实原提交账号且在 `submitted_at + 24 hours` 内可写；其他总部账号、其他角色账号和超时请求被拒绝；取消后可重新选择；一张成功后才可开始下一张；刷新后已提交照片仍可见；五张齐全时 PDF／图片导出不缺图。

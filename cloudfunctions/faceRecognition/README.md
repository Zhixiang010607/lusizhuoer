# faceRecognition 云函数

该函数仅在 CloudBase 后端运行，用于门店客户建档、照片质量检测、私有照片留存、人脸人员库录入和后续人员搜索。客户不需要提供身份证。

当前版本：`2026-08-16-private-pg-storage-v9`

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

## 拍摄和质量要求

- 浏览器内部保存为 JPEG 3:4 竖图，最长边不超过 1280 px；页面预览仍为正方形。
- 图片只能有一张人脸，人脸宽和高均至少 100 px。
- 不允许口罩、闭眼、明显低头、歪头或侧脸。
- 后端会再次执行质量检测，不能依赖前端结果。
- `CreatePerson` 使用算法模型 3.0、`QualityControl=3`、`UniquePersonControl=2`。
- 已经选择客户的核销只调用 `VerifyFace`，现场照片只与数据库中该客户的 `PersonId` 做 1:1 比对，不搜索其他客户。
- `SearchPersons` 仅保留给明确需要 1:N 查人的场景，默认阈值 85，并检查前两名分差。
- 人脸结果只能用于找到候选客户，不能仅凭分数自动扣次；还要展示客户核心信息供员工核对。

## 云存储

- PG 存储桶：`customer-photos`
- 访问权限：私有
- 单文件限制：5 MB
- MIME 白名单：`image/jpeg`
- 对象路径：`<storeId>/<customerCode>/<timestamp>.jpg`

该桶不为 `anon` 或 `authenticated` 创建任何 RLS Policy，客户端访问默认拒绝；只有使用 `service_role` 的云函数可以读写。数据库保存 `pg://<bucketId>/<objectName>` 私有引用，不保存公开下载地址。

## 部署

把本目录中的 `index.js`、`package.json` 和 `README.md` 放在 ZIP 根目录上传。函数入口为 `index.main`，部署时安装 `package.json` 依赖。

部署后测试：

```json
{ "action": "health" }
```

应返回：

```json
{
  "ok": true,
  "version": "2026-08-16-private-pg-storage-v9",
  "photoBucketId": "customer-photos",
  "livenessEnabled": true
}
```

## 支持的动作

- `validateCapture`：拍照后立即检查单人、人脸尺寸、质量、口罩、闭眼和姿态。
- `registerCustomer`：服务端重复质量检查，可选活体检测，然后入人员库、上传私有照片并写客户表。
- `searchCustomer`：质量检查、可选活体检测、人员搜索、阈值和候选分差判断，再从本门店客户表返回档案。

正式上线前还要提供客户授权记录、照片与人脸数据删除流程、访问审计，并确认腾讯云高精度静态活体服务已开通和计费。

# teacherCreate

老师创建的独立同步云函数。函数根目录直接包含 `index.js` 和 `package.json`，可在 CloudBase 控制台选择“本地上传并安装依赖”部署。

## 动作

- `health`：返回版本、支持动作和环境配置检查，不返回密钥。
- `validateCapture`：仅供活跃总部账号检查单张 JPEG 的人脸质量和活体。
- `createTeacher`：单次同步完成认证账号、老师主档、人脸库、私有原图、精确回读和最终激活。

`createTeacher` 没有后台工作者、定时器或轮询接口。浏览器只需等待这一次调用的最终结果。

手机号是老师账号的唯一外部身份。同一个自然人可以用不同手机号创建独立老师账号。安全重试必须沿用同一 `clientRequestId`；新请求不会把已有账号的旧密码误报为本次创建成功。

建议在 CloudBase 中将这个函数的执行超时设为 **120 秒**，内存不低于 **512 MB**。页面会只发起一次同步请求，不需要配置定时触发器。

## 必需环境变量

- `CLOUDBASE_ENV_ID` 或 `TCB_ENV`
- `CLOUDBASE_APIKEY` 或 `CLOUDBASE_SERVICE_ROLE_KEY`
- `FACE_SECRET_ID`
- `FACE_SECRET_KEY`
- `FACE_GROUP_ID`
- `CUSTOMER_PHOTO_BUCKET_ID`（默认 `customer-photos`）

## 可选人脸阈值

- `FACE_QUALITY_THRESHOLD`（默认 70）
- `FACE_LIVENESS_ENABLED`（默认关闭）
- `FACE_LIVENESS_THRESHOLD`（默认 40）
- `FACE_MAX_YAW`（默认 20）
- `FACE_MAX_PITCH`（默认 20）
- `FACE_MAX_ROLL`（默认 15）

只有明确将 `FACE_LIVENESS_ENABLED` 设为 `1`/`true` 时才会调用活体服务；关闭时响应中会明确返回 `liveness.checked: false`，不能将它展示为“活体已检测”。

## 成功边界

只有 Tencent IAI Person/Group/FaceId、私有原图字节与 SHA-256、PostgreSQL 人脸引用、老师/员工活跃状态及 CloudBase Auth `ACTIVE` 都通过独立回读后，才返回 `ok: true, completed: true, proof.complete: true`。

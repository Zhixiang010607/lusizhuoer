# teacherCreate v5

老师创建的独立同步云函数。上传 ZIP 的根目录直接包含 `index.js`、`package.json`
和 `README.md`，在 CloudBase 控制台选择“本地上传并安装依赖”。

## 动作

- `health`：返回版本、动作与环境配置状态，不返回密钥。
- `validateCapture`：仅供活跃总部账号检查 JPEG 质量与活体。
- `createTeacher`：单次完成人脸库、私有原图、ACTIVE 登录账号和 ACTIVE 老师主档。

本服务没有老师创建后的补录、替换或修改人脸 action。老师主页也不提供这些入口。
旧记录或异常记录如缺少完整人脸资料，不能激活；必须先核对并清理 Auth、数据库、
人脸库与原图残留，再从老师创建页重新创建。

创建流程没有后台 worker、轮询、operationId、Timer、嵌套云函数或 051/052 兼容路径。
`staffAccount v66` 和 `faceRecognition v77` 不处理老师人脸写入。053 迁移物理删除旧
操作表和六个私有函数。

运行时不识别或自动续建旧 `teacher-face-saga:*` 认证账号。遇到旧流程留下的 BLOCKED
孤儿账号时会直接返回 `PHONE_ALREADY_PROVISIONED`；必须由管理员在控制台核对 UID、
手机号、状态和 Description 后手工清理。新流程不再创建临时 BLOCKED 账号，也不再
执行创建后的 Person、Group、照片内容或 Auth 状态二次回读；各官方写入接口成功并
返回必要编号后直接进入下一步，与门店账号和客户建档的处理方式一致。

手机号是老师账号的唯一外部身份；同一自然人可用不同手机号建立独立老师账号。
创建时不会按人脸搜索或判断自然人是否重复；系统没有老师 1:N 查人流程。体验核销先按
老师账号定位数据库中绑定的 `PersonId`，再调用 `VerifyFace` 只与该老师做 1:1 比对。
函数建议配置 **120 秒**、至少 **512 MB**，不要配置 Timer。

## 网页调用权限

在现有 CloudBase 云函数安全规则中合并以下条目；不要覆盖顶层 `*` 或其他函数：

```json
"teacherCreate": {
  "invoke": "auth.loginType != 'ANONYMOUS' && auth != null"
}
```

网页出现 `EXCEED_AUTHORITY` 且函数日志中没有同时间调用，说明请求在进入函数前被
安全规则或过期会话拒绝，与人脸 SecretId/SecretKey 无关。

## 必需环境变量

- `CLOUDBASE_ENV_ID` 或 `TCB_ENV`
- `CLOUDBASE_APIKEY` 或 `CLOUDBASE_SERVICE_ROLE_KEY`
- `FACE_SECRET_ID`
- `FACE_SECRET_KEY`
- `FACE_GROUP_ID`
- `CUSTOMER_PHOTO_BUCKET_ID`（默认 `customer-photos`）

## 人脸阈值

- `FACE_QUALITY_THRESHOLD`（默认 70）
- `FACE_LIVENESS_ENABLED`（默认关闭）
- `FACE_LIVENESS_THRESHOLD`（默认 40）
- `FACE_MAX_YAW`（默认 20）
- `FACE_MAX_PITCH`（默认 20）
- `FACE_MAX_ROLL`（默认 15）

只有明确将 `FACE_LIVENESS_ENABLED` 设为 `1`/`true` 才调用活体服务；关闭时必须显示
`liveness.checked: false`，不能写成“活体已检测”。

## 成功边界

新建老师依次要求 Tencent IAI `CreatePerson` 返回 FaceId、私有原图上传调用成功、
CloudBase `CreateUser` 返回 UID，以及 PostgreSQL 写入返回老师编号。全部写入成功后
返回 `ok: true, completed: true, proof.complete: true`；不再用可能存在同步延迟的
二次读取阻止创建。任一步明确失败都不能返回成功，并清理本次请求已创建的资源。

# teacherCreate v4

老师创建的独立同步云函数。上传 ZIP 的根目录直接包含 `index.js`、`package.json`
和 `README.md`，在 CloudBase 控制台选择“本地上传并安装依赖”。

## 动作

- `health`：返回版本、动作与环境配置状态，不返回密钥。
- `validateCapture`：仅供活跃总部账号检查 JPEG 质量与活体。
- `createTeacher`：单次完成 Auth、老师主档、人脸库、私有原图、精确回读和最终激活。

本服务没有老师创建后的补录、替换或修改人脸 action。老师主页也不提供这些入口。
旧记录或异常记录如缺少完整人脸资料，不能激活；必须先核对并清理 Auth、数据库、
人脸库与原图残留，再从老师创建页重新创建。

创建流程没有后台 worker、轮询、operationId、Timer、嵌套云函数或 051/052 兼容路径。
`staffAccount v66` 和 `faceRecognition v77` 不处理老师人脸写入。053 迁移物理删除旧
操作表和六个私有函数。

运行时也不识别或自动删除 `teacher-face-saga:*` 认证账号。遇到旧流程留下的 BLOCKED
孤儿账号时会直接返回 `PHONE_ALREADY_PROVISIONED`；必须由管理员在控制台核对 UID、
手机号、状态和 Description 后手工清理，新函数不会替管理员猜测归属。只有同一
`teacher-create:<clientRequestId>` 且完整已建档、所有精确回读都一致的老师才可幂等
回读；新请求不会把未应用的新密码误报为创建成功。已有老师主档但 Auth 缺失时同样
返回 `AUTH_ACCOUNT_MISSING`，不会借旧主档自动续建。

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

新建老师只有 Tencent IAI Person/Group/FaceId、私有原图字节与 SHA-256、PostgreSQL
人脸引用、老师／员工主档及 Auth `ACTIVE` 全部独立回读通过，才返回
`ok: true, completed: true, proof.complete: true`。任一步失败都不能返回创建成功；
可确认归属的本次残留会按创建流程回滚，清理结果不确定时必须由管理员核对后再重试。

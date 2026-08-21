# teacherCreate v2

老师创建与人脸维护的独立同步云函数。上传 ZIP 的根目录直接包含
`index.js`、`package.json` 和 `README.md`，在 CloudBase 控制台选择“本地上传并安装依赖”。

## 动作

- `health`：返回版本、动作与环境配置状态，不返回密钥。
- `validateCapture`：仅供活跃总部账号检查 JPEG 质量与活体。
- `createTeacher`：单次完成 Auth、老师主档、人脸库、私有原图、精确回读和激活。
- `upsertTeacherFace`：总部在老师主页单次补录或更换人脸，不改变老师的激活／封存状态。

两个写动作都没有后台 worker、轮询、operationId、Timer、嵌套云函数或
051/052 兼容路径。`staffAccount v65` 和 `faceRecognition v76` 已删除旧委托入口。
053 迁移物理删除旧操作表和六个私有函数。

运行时也不识别或自动删除 `teacher-face-saga:*` 认证账号。遇到旧流程
留下的 BLOCKED 孤儿账号时会直接返回 `PHONE_ALREADY_PROVISIONED`；必须由管理员
在控制台核对 UID、手机号、状态和 Description 后手工清理，新函数不会替管理员
猜测归属。只有同一 `teacher-create:<clientRequestId>` 且完整已建档、所有
精确回读都一致的老师才可幂等回读；新请求不会把未应用的新密码误报为创建成功。
已有老师主档但 Auth 缺失时同样会返回 `AUTH_ACCOUNT_MISSING`，不会借旧主档
自动续建；需先人工查明残留原因。

手机号是老师账号的唯一外部身份；同一自然人可用不同手机号建立独立老师账号。
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

## 可选人脸阈值

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
`ok: true, completed: true, proof.complete: true`。

补录／更换只有新 Person/FaceId、原图字节与 SHA-256及数据库新引用全部一致才成功。
捕获到的失败会以条件更新恢复原人脸元数据，不激活、不封存老师。

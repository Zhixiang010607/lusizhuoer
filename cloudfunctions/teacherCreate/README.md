# teacherCreate v9

老师账号创建与考勤人脸录入的独立同步云函数。上传 ZIP 的根目录直接包含
`index.js`、`package.json` 和本 README，在 CloudBase 控制台选择“本地上传并安装依赖”。

## 当前规则

- 只有活跃总部账号可以创建老师。
- 请求必须包含老师姓名、中国大陆手机号、初始密码、客户端请求编号、老师明确同意标记和当场拍摄的正面照片。
- 创建前执行单人脸、大小、清晰度、遮挡、闭眼和角度检查，并按环境配置执行活体检测。
- 通过后在腾讯人脸库建立考勤专用 Person，把录入照保存到私有照片桶，再原子写入 ACTIVE 的 Auth、`staff_accounts`、`teachers` 和 `teacher_attendance_face_profiles`。
- 成功必须回读并确认登录账号、老师主档和考勤人脸档案完整；任一环节失败都按依赖顺序补偿本次新建资源，清理不能确认时返回 `TEACHER_CREATE_CLEANUP_INCOMPLETE`。v9 在迁移 082 后允许总部现场重新扫脸：先建立并验证新的独立考勤 Person 与私有建档照，再原子替换数据库档案并写入不可变审计，成功前旧档案继续有效；历史考勤、日报和所有核销链路不变。v8 的创建恢复和安全补偿规则继续保留。
- 考勤面容只供打卡 1:1 验证，绝不参与登录、激活、客户选择、充值、退费、正常核销或体验核销。
- 老师打卡的现场照片由 `faceRecognition v126` 在内存中验证，不保存。本函数保存的仅是总部建老师或重新扫脸时取得同意的私有录入照。
- 手机号仍是人员的唯一外部身份；相同手机号已存在业务账号或 Auth 用户时拒绝重复创建。

旧 `teacher_face_operations` Saga、后台 worker、轮询、operationId、Timer 和
051／052 兼容路径仍然退役。迁移 075 的考勤档案不是旧业务老师人脸的恢复。

## 动作

- `health`：返回 `teacher-create-v9`、动作列表和环境配置状态。
- `createTeacher`：一次完成考勤照片校验、人脸档案、ACTIVE 登录账号和 ACTIVE 老师主档。
- `recoverTeacherCreation`：仅总部用于恢复同一未完成请求；已完整成功则回读成功，未形成业务主档则清理可证明属于该请求的残留。
- `replaceTeacherAttendanceFace`：仅活跃总部为活跃老师现场替换考勤专用人脸；必须有明确授权和前置摄像头照片。

## 调用权限

在现有 CloudBase 云函数安全规则中合并以下条目；不要覆盖顶层 `*` 或其他函数：

```json
"teacherCreate": {
  "invoke": "auth.loginType != 'ANONYMOUS' && auth != null"
}
```

函数内部还会按当前 UID 回读 PostgreSQL，只有活跃总部账号可以执行创建。

## 必需环境变量

- `CLOUDBASE_ENV_ID` 或 `TCB_ENV`
- `CLOUDBASE_APIKEY`（兼容 `CLOUDBASE_SERVICE_ROLE_KEY`）
- `FACE_SECRET_ID`
- `FACE_SECRET_KEY`
- `FACE_GROUP_ID`
- `CUSTOMER_PHOTO_BUCKET_ID`（可省略，默认 `customer-photos`）

照片质量、活体和角度阈值与客户建档共用 `FACE_QUALITY_THRESHOLD`、
`FACE_LIVENESS_ENABLED`、`FACE_LIVENESS_THRESHOLD`、`FACE_MAX_YAW`、
`FACE_MAX_PITCH`、`FACE_MAX_ROLL`。建议超时 **90 秒**、内存 **256 MB** 或以上，
不要配置 Timer。

上传包必须命名为 `teacherCreate-v9.zip`，并在交付前回读 ZIP 根目录 README 和
`index.js`，确认公开版本均为 v9。

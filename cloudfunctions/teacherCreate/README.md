# teacherCreate v6

老师账号创建的独立同步云函数。上传 ZIP 的根目录直接包含 `index.js`、
`package.json` 和 `README.md`，在 CloudBase 控制台选择“本地上传并安装依赖”。

## 当前规则

- 只有活跃总部账号可以创建老师。
- 只接收姓名、中国大陆手机号、初始密码和客户端请求编号。
- 手机号是人员的唯一外部身份；同一手机号不能再建立老师、门店或总部账号。
- 老师创建不采集照片、不调用人脸服务、不写人脸库，也不保存老师照片。
- 成功必须同时确认 CloudBase Auth、`staff_accounts` 和 `teachers` 都为
  `ACTIVE`；服务不读取或写入任何老师人脸字段。
- 体验核销由当前老师账号自动绑定额度，现场只验证所选客户的 1:1 人脸。

本服务没有老师人脸创建、检测、补录、替换、修改、搜索或回读 action，也没有
后台 worker、轮询、operationId、Timer 或 051/052 兼容路径。

## 动作

- `health`：返回 `teacher-create-v6`、动作列表和环境配置状态。
- `createTeacher`：单次创建 ACTIVE 登录账号和 ACTIVE 老师主档。

创建时先检查业务库和 CloudBase Auth 中是否已有相同手机号，再创建 ACTIVE Auth
账号，最后用一条数据库语句写入账号与老师主档并回读状态。数据库步骤失败时会
删除本次创建的 Auth；清理无法确认时返回
`TEACHER_CREATE_CLEANUP_INCOMPLETE`，绝不显示创建成功。

## 网页调用权限

在现有 CloudBase 云函数安全规则中合并以下条目；不要覆盖顶层 `*` 或其他函数：

```json
"teacherCreate": {
  "invoke": "auth.loginType != 'ANONYMOUS' && auth != null"
}
```

网页出现 `EXCEED_AUTHORITY` 且函数日志中没有同时间调用，说明请求在进入函数前被
安全规则或过期会话拒绝。

## 必需环境变量

- `CLOUDBASE_ENV_ID` 或 `TCB_ENV`

`FACE_SECRET_ID`、`FACE_SECRET_KEY`、`FACE_GROUP_ID` 和照片桶变量均不再是
`teacherCreate v6` 的依赖，可以从这个云函数的环境变量中移除。

建议超时设置 **60 秒**、内存 **256 MB** 或以上，不要配置 Timer。

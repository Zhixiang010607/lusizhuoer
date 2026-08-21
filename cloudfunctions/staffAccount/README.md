# staffAccount 云函数

当前版本：`v67`

`staffAccount` 负责员工会话、总部／门店账号、人员状态、老师体验额度、产品、审核与总部统计。它不再创建老师，也不再处理任何老师人脸写入。

## 老师创建与人脸边界

老师只能通过独立 `teacherCreate v6` 创建。创建只需要姓名、手机号和初始密码，
不上传照片、不建立老师人脸，也不把人脸作为创建、激活、登录或业务选择条件。
老师主页没有补录、替换或修改人脸入口。`staffAccount v67` 已彻底移除旧的老师
Saga，不保留旧发布兼容入口，也不读取或写入 `teacher_face_operations`：

- `beginTeacherProvisionWithFace`
- `provisionTeacherWithFace`
- `readTeacherProvisionResult`
- `upsertTeacherFace`
- `reconcileTeacherFaceOperation`
- `getTeacherFaceOperationStatus`

调用这些旧 action 会统一进入“不支持的操作”。`provisionStaff({ role: "teacher" })` 也会在 Auth 查询、用户创建和 SQL 写入之前返回 `TEACHER_CREATE_SERVICE_REQUIRED`。新建老师只能调用 `teacherCreate`。

迁移 051／052 的旧表、函数和历史记录不再是本函数的运行依赖。部署
`staffAccount v67`／`faceRecognition v84`／`teacherCreate v6` 后执行前向
迁移 053，会物理删除旧操作表与六个私有函数，不影响老师及业务历史。

## 保留能力

以下老师相关能力仍由本函数负责，并且与人脸流程彼此独立：

- `listStaff({ role: "teacher" })`：读取老师目录及老师主档状态。
- `setMasterStatus({ teacherId, status })`、`setStaffStatus(...)`：同步封存或激活老师主档、业务账号和 CloudBase 登录状态；老师人脸字段不参与状态判断。
- `getTeacherExperienceEntitlements({ teacherId })`：读取额度配置与完整历史。
- `upsertTeacherExperienceEntitlement(...)`：配置月度额度。
- `deleteTeacherExperienceEntitlement(...)`：封存额度配置，保留历史。
- `rechargeTeacherExperienceEntitlement(...)`：写入独立、不可变的老师体验充值流水。
- `resetTeacherExperienceQuotas()`：总部手动补跑月度重置。

老师状态与额度依赖既有 046、048、049、050 数据库能力。目录与历史额度仍可查询。
老师赠送体验核销时，服务端按登录账号绑定老师额度，并只核验和保存所选客户的人脸。

非老师能力保持不变，包括会话与总部引导、门店建档和账号管理、产品与回执模板、审核队列、人员密码和状态、总部统计，以及运营身份下线维护。

## 环境变量

必需或按功能使用：

- `BOOTSTRAP_HQ_UID`：首个总部管理员的 CloudBase UID。
- `CLOUDBASE_ENV_ID` 或 `TCB_ENV`：CloudBase 环境。
- `CLOUDBASE_APIKEY`（兼容 `CLOUDBASE_SERVICE_ROLE_KEY`）：服务端用户管理和产品模板私有存储。
- `PRODUCT_TEMPLATE_BUCKET_ID`：产品模板私有桶；默认 `product-templates`。

`staffAccount` 不需要 `FACE_SECRET_ID`、`FACE_SECRET_KEY`、`FACE_GROUP_ID` 或老师照片桶配置。

## 月度额度 Timer

本函数只保留老师体验额度月度重置 Timer。旧的 `reconcile-teacher-face-operations` Timer 必须从 `staffAccount` 触发器配置中删除。

```json
{
  "triggers": [
    {
      "name": "reset-teacher-experience-quotas-monthly",
      "type": "timer",
      "config": "0 0 0 1 * * *",
      "enable": true
    }
  ]
}
```

控制台时区选择 `Asia/Shanghai`。函数只接受平台 Timer 事件，并校验 `TRIGGER_SRC=timer`、函数名、触发器名、事件时间及无终端用户 UID；普通客户端不能伪造月度重置。

## 部署与验收

1. 使用 Node.js 18 部署本目录的 `index.js`、`package.json` 和依赖。
2. 配置上述环境变量，并将安全规则限制为已登录且非匿名用户。
3. 删除 `staffAccount` 上的旧人脸补偿 Timer，只保留月度额度 Timer。
4. 部署后调用 `{ "action": "health" }`。

健康检查必须返回：

```json
{
  "ok": true,
  "version": "v67",
  "teacherExperienceResetTimerTriggerName": "reset-teacher-experience-quotas-monthly",
  "teacherCreationService": "teacherCreate",
  "teacherFaceOperationsOwnedByStaffAccount": false
}
```

健康响应中不再出现老师 Saga、Auth 创建回执、同请求恢复、051／052 租约或人脸补偿 Timer 字段。

密码继续遵循 CloudBase 规则：8–32 位，且大写、小写、数字、特殊字符四类中至少包含三类。业务角色只从 PostgreSQL `staff_accounts` 解析，不写入 CloudBase 用户描述 JSON。

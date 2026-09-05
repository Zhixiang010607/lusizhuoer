# staffAccount 云函数

当前版本：`v81`

`staffAccount` 负责员工会话、总部／门店账号、人员状态、老师体验额度、项目、独立产品、审核与总部统计。v81 在 v80 的大数据分页和统一产品查询基础上，为每个老师体验配置返回上海自然月内的独立充值次数与已完成体验次数；月度体验从不可变扣次流水和已通过工单重新汇总，不以可被重新配置的可变计数器代替历史。删除配置仍只做封存，重新配置不会清空既有工单、扣次、充值、重置或配置审计记录。本函数不再创建老师，也不再处理任何老师人脸写入。

## 登录与会话边界

`staffAccount v81` 同时支持现有手机号＋密码登录和微信小程序手机号快捷登录。两种方式必须在 CloudBase 身份源中关联到同一个已有 Auth 用户和同一 UID；业务角色、账号状态和门店范围仍只从该 UID 对应的 PostgreSQL `staff_accounts` 回读。总部老师维度统计只认来源与业务类型都符合矩阵的 `teacher_id`：门店来源仅限充值、退费和正常核销，老师来源仅限该提交账号本人办理的充值、退费、正常核销和体验核销。历史总部、退役角色、老师错绑、门店体验或补录核销仍保留在总量、门店和项目统计中，但不会产生老师归属；排名将这些有效事实单独汇总为“未指定老师”，不会计到任何真实老师名下。总部审核与门店精确工单读取采用相同口径；其他历史工单保留但显示“未指定”。

小程序快捷登录流程为：

1. 用户在 `open-type="getPhoneNumber"` 按钮上明确授权，小程序只把当次一次性 `phoneCode` 交给 CloudBase SDK 的 `auth.signInWithPhoneAuth({ phoneCode })`。
2. CloudBase 校验微信身份和手机号，按已验证手机号关联现有 Auth 用户；小程序不自行解密手机号。
3. 取得 CloudBase 会话后，客户端调用无手机号参数的 `{ "action": "session" }`。`staffAccount` 只信任平台认证上下文中的当前 UID，不使用客户端手机号查找账号。
4. UID 未绑定业务账号，或账号／门店／老师已封存时直接拒绝。快捷登录不创建业务账号，不修改 `staff_accounts.auth_uid`，也不得把新 UID 自动改绑到旧员工。

`session` 的公开请求固定为：

```json
{ "action": "session" }
```

不得再传入 `phone`、`role`、`storeId` 或其他身份范围参数。应用代码不记录或自行持久化 `phoneCode`、微信 session key、CloudBase access／refresh token 或密码；CloudBase 登录凭据仅由官方 SDK 管理。登录失败时必须退出 CloudBase 会话并清除本地业务会话。手机号＋密码继续作为应急入口。

## 老师创建与人脸边界

老师只能通过独立 `teacherCreate v6` 创建。创建只需要姓名、手机号和初始密码，
不上传照片、不建立老师人脸，也不把人脸作为创建、激活、登录或业务选择条件。
老师主页没有补录、替换或修改人脸入口。`staffAccount v81` 已彻底移除旧的老师
Saga，不保留旧发布兼容入口，也不读取或写入 `teacher_face_operations`：

- `beginTeacherProvisionWithFace`
- `provisionTeacherWithFace`
- `readTeacherProvisionResult`
- `upsertTeacherFace`
- `reconcileTeacherFaceOperation`
- `getTeacherFaceOperationStatus`

调用这些旧 action 会统一进入“不支持的操作”。`provisionStaff({ role: "teacher" })` 也会在 Auth 查询、用户创建和 SQL 写入之前返回 `TEACHER_CREATE_SERVICE_REQUIRED`。新建老师只能调用 `teacherCreate`。

迁移 051／052 的旧表、函数和历史记录不再是本函数的运行依赖。部署
`staffAccount v81`／`faceRecognition v113`／`teacherCreate v6` 后执行前向
迁移 053，会物理删除旧操作表与六个私有函数，不影响老师及业务历史。

## 保留能力

以下老师相关能力仍由本函数负责，并且与人脸流程彼此独立：

- `listStaff({ role: "teacher" })`：读取老师目录及老师主档状态。
- `setMasterStatus({ teacherId, status })`、`setStaffStatus(...)`：同步封存或激活老师主档、业务账号和 CloudBase 登录状态；老师人脸字段不参与状态判断。
- `getTeacherExperienceEntitlements({ teacherId })`：读取额度配置与完整审计历史；每个活跃配置同时返回当前基础额度、当前可用、上海自然月内不可变充值流水合计、上海自然月内已通过体验核销合计和累计体验。业务累计只统计来源可信、已通过且由该老师本人提交的体验核销，历史异常扣减仍保留在余额和流水中。
- `upsertTeacherExperienceEntitlement(...)`：配置月度额度。
- `deleteTeacherExperienceEntitlement(...)`：封存额度配置，保留历史。
- `rechargeTeacherExperienceEntitlement(...)`：写入独立、不可变的老师体验充值流水。
- `resetTeacherExperienceQuotas()`：总部手动补跑月度重置。

老师状态与额度依赖既有 046、048、049、050 数据库能力。目录与历史额度仍可查询。
老师赠送体验核销时，服务端按登录账号绑定老师额度，并只核验和保存所选客户的人脸。

非老师能力包括会话与总部引导、门店建档和账号管理、项目与回执模板、独立产品主档、审核队列、人员密码和状态、总部统计，以及运营身份下线维护。

## 项目与产品边界

`v81` 将两个概念明确分开：

- 既有 `public.products` 与 `listProducts`／`createProduct`／`setProductStatus` 保持接口兼容，但业务名称统一为“项目”。它继续承载充值、退费、正常核销、体验额度、项目 LOGO 和单据模板，项目编号仍为 `PRD...`。
- 新增 `public.retail_products` 与 `listRetailProducts`／`createRetailProduct`／`setRetailProductStatus`，只管理涂抹类／实物产品。页面只录入产品名称，数据库自动生成 `PDT...` 编号；状态只允许 `ACTIVE`／`ARCHIVED`，不提供删除 action，迁移 060 的触发器也会拒绝物理删除。
- 三个独立产品 action 均只允许总部账号调用。产品不会进入项目下拉框、客户余额、核销、体验额度、项目汇总、排名或项目凭证模板；迁移 061 后，活跃产品只可作为充值单第三步的可选赠品主档，赠品不改变库存、项目次数或业务统计。
- 同名产品不能重复新增；封存产品应重新激活原记录。每次状态变化由数据库写入状态历史。
- 迁移 062 后，`reviewRetailProductPurchase` 只允许活跃总部账号审核独立购买单。购买审核与充值／退费审核分开；通过后才由客户主页汇总读取，审核本身不修改项目余额或库存。
- `listRetailProductPurchaseReviews` 为兼容保留名称，但 v81 的总部“产品查询”读取两种来源：`PURCHASE` 来自独立产品购买表，`GIFT` 来自迁移 061 的充值赠品不可变明细。接口接受来源、门店、独立产品、审核状态、姓名、生日、提交日期和完整工单号，返回来源汇总、状态汇总与稳定分页。`GIFT` 行的工单号、状态、提交／审核时间和详情 ID 均取父充值单；客户端必须显示“充值赠送”并进入父 `RC...` 工单，不得另造赠品单。产品购买审核页、购买详情和审核动作必须显式传 `sourceType: "PURCHASE"`，不得把赠品放入第二次审核。

`v81` 的总部排名读取使用严格的三段选择：`dimension` 只允许 `store`／`teacher`，`productId` 留空代表全部项目或传入一个真实项目 ID，`rankingMetric` 只允许 `recharge`／`verification`／`experience`／`refund`。数据库先按日期和项目过滤已通过业务，再按所选业务次数字段降序；当前为 `ACTIVE` 的门店／老师即使范围内四项均为 0 也进入候选集合，已封存门店／老师只有在范围内至少存在一条有效业务时才进入。老师维度对无法可信归属到真实老师的有效业务增加单独“未指定老师”汇总项，因而老师排名合计与同筛选条件的全局业务合计一致，同时不改变任何真实老师的归属。响应回显 `dimension`、`productId`、`rankingMetric` 和该业务的 `rankingTotal`，客户端必须核对回显后才显示排名。旧版按四类合计排序、把项目作为排名对象、遗漏 0 次激活老师、遗漏未归属业务或把 0 次封存主档列入排名的规则已退役。

`v81` 另提供 `getHqDashboard({ mode: "product-summary" })` 的完整项目汇总分页。它以 `public.products` 为主表，因此无业务记录和已封存但仍保留历史的项目也不会从项目目录中消失；四类次数只统计所选日期内已通过的业务。响应每页默认 10 项、最多 500 项，回传 `pageNumber`、`pageSize`、`total`、`totalPages` 和当前页 `rows`。客户端必须逐页展示全部项目，页面底部的四类合计来自同一日期范围的全局总数，不得用当前页小计或旧 Top 10 图表代替。总部看板可以显式传入 `allTime: true` 从最早有效充值／退费／核销／体验记录统计到今天；该模式不得同时传入开始或结束日期。

## 环境变量

必需或按功能使用：

- `BOOTSTRAP_HQ_UID`：首个总部管理员的 CloudBase UID。
- `CLOUDBASE_ENV_ID` 或 `TCB_ENV`：CloudBase 环境。
- `CLOUDBASE_APIKEY`（兼容 `CLOUDBASE_SERVICE_ROLE_KEY`）：服务端用户管理和项目模板私有存储。
- `PRODUCT_TEMPLATE_BUCKET_ID`：项目模板私有桶；默认 `product-templates`。

`staffAccount` 不需要 `FACE_SECRET_ID`、`FACE_SECRET_KEY`、`FACE_GROUP_ID` 或老师照片桶配置。

微信小程序快捷登录也不为 `staffAccount` 新增 AppSecret 或自定义登录私钥环境变量。微信小程序 AppSecret 只配置在 CloudBase 身份源的服务端设置中，不得进入小程序、云函数环境变量、README、ZIP、日志或截图。

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

上传包文件名必须为 `staffAccount-v81.zip`。ZIP 根目录直接包含：

```text
index.js
package.json
README.md
```

不得在 ZIP 中再套 `staffAccount/` 目录。平台按根目录 `package.json` 安装依赖；交付前必须回读 ZIP 根目录的 `README.md`，确认其显示当前版本 `v81`，并确认 ZIP 内 `index.js` 的运行时版本同样为 `v81`。

生产切换顺序：

1. 在 CloudBase 身份源中配置类型 `WX_MICRO_APP` 并绑定正确小程序 AppID；设置 `On=TRUE`、`AutoSignInWhenPhoneNumberMatch=TRUE`、`TransparentMode=FALSE`、`ReuseUserId=FALSE`，同时保留现有手机号＋密码登录方式。全托管持久身份模式可能固定回显 `AutoSignUpWithProviderUser=TRUE`；这只建立 Auth 身份，业务会话仍只认既有 UID 映射，未绑定身份必须拒绝。
2. 依次执行并验收迁移 060、061、062，再打包并上传 `staffAccount-v81.zip`，使用 Node.js 20，配置上述环境变量，并将安全规则限制为已登录且非匿名用户。v81 的精确充值工单详情和统一产品查询会读取 061 中不可变的赠品明细，并通过 062 的独立函数审核产品购买单。
3. 客户评价作为独立同轮服务部署：执行并验收 068，配置至少 32 字节的 `CUSTOMER_RATING_SIGNING_KEY` 及实际 `rating.html` 地址 `CUSTOMER_RATING_BASE_URL`，上传 `customerRating-v7.zip` 并确认其 `health`。`staffAccount v81` 不签发或写入评价。
4. 删除 `staffAccount` 上的旧人脸补偿 Timer，只保留月度额度 Timer。
5. 部署后先调用 `{ "action": "health" }`，确认版本和配置就绪；再分别用现有已登录会话和微信手机号授权后的会话调用无参数 `{ "action": "session" }`，确认返回的 UID、角色和门店与旧密码账号完全一致。
6. `staffAccount v81` 验收通过后才发布当前小程序；不得先发布依赖新产品查询、快捷登录和无参数 `session` 的客户端。

健康检查必须返回：

```json
{
  "ok": true,
  "version": "v81",
  "managerNodeInstalled": true,
  "teacherExperienceResetTimerTriggerName": "reset-teacher-experience-quotas-monthly",
  "teacherCreationService": "teacherCreate"
}
```

健康响应中不再出现老师 Saga、Auth 创建回执、同请求恢复、051／052 租约或人脸补偿 Timer 字段。

密码继续遵循 CloudBase 规则：8–32 位，且大写、小写、数字、特殊字符四类中至少包含三类。业务角色只从 PostgreSQL `staff_accounts` 解析，不写入 CloudBase 用户描述 JSON。

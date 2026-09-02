# 腾讯云 CloudBase SQL 编辑器执行说明

`ExecutePGSql` SQL 编辑器不适合一次提交包含多个 PL/pgSQL 函数的长迁移。完整的 `037`--`047` 文件保留给正式 migration 工具；在腾讯云控制台中请改用本目录的短文件。

如果控制台此前已经出现红色事务错误，先新建一次独立查询，仅执行：

```sql
ROLLBACK;
```

然后每次清空编辑器，只粘贴一个文件，按 `Ctrl+A` 选中整个短文件后执行。看到该文件 `COMMIT` 成功后再继续：

1. `037-01-photo-schema-and-guard.sql`
2. `037-02-create-verification-function.sql`
3. `037-03-extra-photo-function.sql`
4. `038-01-five-slot-schema-upgrade.sql`
5. `038-02-create-verification-function.sql`
6. `038-03-extra-photo-function.sql`
7. `038-04-verify-photo-migrations.sql`（只读验收）
8. `039-01-direct-upload-schema.sql`
9. `039-02-begin-upload-function.sql`
10. `039-03-commit-upload-function.sql`
11. `039-04-cancel-upload-function.sql`
12. `039-05-verify-direct-upload.sql`（只读验收）
13. `040-01-fix-verification-photo-commit-ambiguity.sql`（修复补充照片提交时 `photo_slot` 歧义）

如果 039 已经执行成功、但补充照片上传报 `column reference "photo_slot" is ambiguous (SQLSTATE 42702)`，不要重跑 037--039，只需完整执行一次 `040-01-fix-verification-photo-commit-ambiguity.sql`。它仅替换原子提交函数，不改表、不删除或重写已有照片数据。

照片迁移已经完成后，如需核对 v52 当前使用的真实 PG 存储桶，可单独执行
`photo-storage-v52-readonly-check.sql`。它只读检查桶 ID、私有状态、单文件上限、JPEG MIME、迁移 039 表以及现有 RLS 策略，不是新 migration，不需要按编号重复执行。私有照片桶没有面向 `anon`／`authenticated` 的整桶策略是预期状态；服务端 `service_role` 会绕过 RLS，实际 Key 是否可访问由 v52 的 `health.verificationPhotoServiceRoleStorageReady` 验证。

不要把 `ROLLBACK;` 与上述文件放在同一次执行中；不要选中函数的一部分执行；已经成功提交的前一部分不要重复运行。

## `037-01` 已成功、旧版 `037-02`／`037-03` 失败时

不需要重跑 `037-01`。先新建独立查询只执行一次 `ROLLBACK;`，然后重新下载当前版本并依次执行：

1. `037-02-create-verification-function.sql`
2. `037-03-extra-photo-function.sql`
3. `038-01-five-slot-schema-upgrade.sql`
4. `038-02-create-verification-function.sql`
5. `038-03-extra-photo-function.sql`
6. `038-04-verify-photo-migrations.sql`
7. `039-01-direct-upload-schema.sql`
8. `039-02-begin-upload-function.sql`
9. `039-03-commit-upload-function.sql`
10. `039-04-cancel-upload-function.sql`
11. `039-05-verify-direct-upload.sql`
12. `040-01-fix-verification-photo-commit-ambiguity.sql`

旧版 `037-02` 的状态判断缺少 `CASE` 表达式括号，会报 `syntax error at end of input (SQLSTATE 42601)`；旧版 `037-03` 随后提示 `create_verification_with_face_photo ... does not exist` 是同一问题造成的连锁错误。当前文件已在真实 PostgreSQL 引擎中按上述顺序完整执行通过。

## 046、047 运营身份下线与 048 老师额度生命周期

对当前版本，先按编号完成所有尚未执行的迁移，并将 `046-01` 至
`046-08` 各自作为独立事务执行。**不要在此时先执行 047。** 正确的
切换顺序是：

1. 执行 `046-01-teacher-face-schema.sql` 至
   `046-08-permissions-and-comments.sql`，每个文件确认 `COMMIT` 成功；
2. 部署 `faceRecognition v69` 与 `staffAccount v55`，分别调用 `health`
   确认新版本；
3. 在仅限总部使用、已加载当前 `cloudbase-phone-auth.js` 的临时维护页面中，
   以已登录总部身份在浏览器控制台运行
   `await CloudBasePhoneAuth.retireOperationAccounts()`。必须等到返回成功、
   旧运营账号的 CloudBase 凭据已被封锁；该维护页不是最终静态发布；如有失败，先修复并安全重试；
4. 只有第 3 步成功后，依次完整执行
   `047-01-retire-operation-accounts.sql` 和
   `047-02-hq-reviewer-guard.sql`；
5. 依次完整执行 `048-01-quota-lifecycle-schema.sql` 至
   `048-07-comments.sql`，每个文件确认 `COMMIT` 成功；
6. 部署 `faceRecognition v72` 与 `staffAccount v55`，分别调用 `health`
   确认新版本；
7. 最后才部署当前静态前端并强制刷新浏览器。

047 不删除旧运营账号、审核人或业务记录：它封存相关账号、身份、角色、
权限和范围以保留历史外键与审计，并禁止重新创建、激活或复用运营身份。
第二段还把充值和补录核销审核限定为总部。不要把两个 047 文件与
`ROLLBACK;` 或其他文件粘在同一次执行中。

048 不删除老师产品额度的历史流水：`delete` 只封存当前可用配置，充值、
月度重置和体验核销历史仍保留；重新配置会立即把当前可用次数改为新值。它
也确认老师人脸不是老师账号活跃或业务选择的前置条件；当前版本已完全取消老师人脸采集。
每月上海时间 1 日 00:00 的重置只处理活跃老师、活跃产品和活跃额度配置。

## 051 / 052 已退役

051 和 052 是旧老师人脸 Saga 的历史迁移，只供已执行生产库追溯，不再是当前运行依赖。
不要再新增 `reconcile-teacher-face-operations` Timer。

## 053 删除旧老师人脸 Saga

先部署 `staffAccount v76`、`faceRecognition v98` 和 `teacherCreate v6`，再按
[`053-README.md`](053-README.md) 执行 `053-01-retire-legacy-teacher-face-saga.sql`，最后运行
`053-readonly-verify.sql`，7 行必须全部为 `RETIRED`。

## 054 老师赠送体验使用客户人脸

完成 053 后，按 [`054-README.md`](054-README.md) 完整执行
`054-01-teacher-only-customer-face-experience.sql`，然后部署
`faceRecognition v98`、`staffAccount v76`、`teacherCreate v6` 和当前静态前端。
054 会在数据库层把体验创建限定为额度所属的当前老师账号，并把新体验凭证切换为
客户登记照与客户现场照；历史照片不改写。

## 055 移除订单中的老师人脸门禁

完成 054 后，按 [`055-README.md`](055-README.md) 完整执行
`055-01-remove-teacher-face-order-guards.sql`，最后 3 行必须全部为 `READY`。
055 修复历史 046 函数仍阻止无老师人脸账号办理充值、退费、普通核销和体验核销的问题；
老师主档与账号仍必须活跃，客户档案照与客户现场 1:1 人脸仍然必须存在。

## 056—058 当前工单完整性

完成 055 后依次执行 056 与 057，并确认各自末尾只读检查全部为 `READY`。最后按
[`058-README.md`](058-README.md) 分别执行 058 的两个函数、触发器事务和只读验收；
最后两行必须全部为 `READY`。058 恢复当前充值／退费与正常／体验核销的数据库状态机，
锁定提交人、门店、客户、产品、次数和防重复编号等审计字段。前端超时只会按原请求编号查回既有工单，结果未确认时禁止生成新编号或再次扣次。

## 059 业务老师矩阵与归属

完成 058 后按 [`059-README.md`](059-README.md) 严格执行以下九步：

1. 整文件执行只读 `059-preflight-store-binding-layout.sql`；
2. 整文件执行只读 `059-preflight-business-teacher-attribution.sql`；
3. 确认门店绑定布局为 `READY_CURRENT` 或 `READY_LEGACY`，并复核所有非 `READY`／`EMPTY` 的历史计数；
4. 确认历史门店单据中的 `teacher_id` 确实代表当时选择的业务老师；
5. 整文件执行 `059-00-store-binding-prerequisites.sql`；
6. 整文件执行 `059-01-business-teacher-function.sql`；
7. 整文件执行 `059-02-business-teacher-triggers.sql`；
8. 整文件执行只读 `059-readonly-verify-store-binding.sql`；
9. 整文件执行只读 `059-readonly-verify.sql`。

最后两段验证的每一行都必须为 `READY`。059 曾固化门店充值／退费老师可选、门店正常核销老师必选、门店体验核销拒绝、老师账号自动绑定本人的写入边界；其中“门店正常核销老师必选”已被后续 065 明确退役。历史环境仍须先完成 059，再继续执行到 065，最终规则以 065 为准。

## 060 独立产品主档

完成 059 后按 [`060-README.md`](060-README.md) 执行：

1. 整文件执行 `060-01-retail-products.sql`；
2. 整文件执行只读 `060-readonly-verify.sql`，4 行必须全部为 `READY`；
3. 上传并验收 `staffAccount-v76.zip` 后，再使用网页版或小程序新增产品。

060 不修改既有 `public.products` 项目和任何历史业务。新 `public.retail_products` 只保存涂抹类／实物产品名称、自动编号、状态与内部审计；产品只能封存或重新激活，删除保护触发器会拒绝物理删除。

## 061 充值产品赠予

完成并验收 060 后按 [`061-README.md`](061-README.md) 执行：

1. 整文件执行 `061-01-recharge-product-gifts.sql`；
2. 整文件执行只读 `061-readonly-verify.sql`，8 行必须全部为 `READY`；
3. 上传并验收 `faceRecognition-v98.zip` 与 `staffAccount-v76.zip` 后，再发布包含充值第三步赠品的网页和小程序。

061 只为 `NEW` 充值单增加可选、不可变的产品赠品明细。每行固定绑定父充值单的门店、客户和业务老师，并保存当时的产品编号、名称与数量快照；退费不能带赠品，赠品也不进入库存、客户项目余额、核销、体验额度或统计。

## 062 独立产品购买

完成并验收 060、061 后按 [`062-README.md`](062-README.md) 执行：

1. 整文件执行 `062-01-retail-product-purchases.sql`；
2. 整文件执行 `062-readonly-verify.sql`，4 项均须为 `READY`；
3. 上传并验收 `faceRecognition-v98.zip` 与 `staffAccount-v76.zip`，再发布含“产品购买”入口和独立审核页的网页／小程序。

062 只建立产品购买工单和总部审核状态机。门店与老师提交，总部审核；待审核和驳回不计入客户汇总。客户主页“购买”来自已通过购买单，“赠送”来自父充值单已通过的 061 赠品。

## 063 数据库安全封锁

完成现有业务迁移后，必须按 [`063-README.md`](063-README.md) 依次整文件执行：

1. `063-01-existing-object-lockdown.sql`；
2. `063-02-default-privilege-lockdown.sql`；
3. `063-03-paid-verification-balance-guard.sql`；
4. 只读 `063-readonly-verify-01-access.sql`；
5. 只读 `063-readonly-verify-02-defaults-and-balance.sql`。

最后 8 行 `record_count` 必须全部为 `0`、`status` 全部为 `READY`。第 1 步会立即
撤销 `PUBLIC`／`anon`／`authenticated` 对现有 `public` schema、表、序列和函数的
直连权限；第 2 步封锁当前迁移账号的未来对象默认权限，并安全跳过当前账号无权
修改的腾讯云平台角色；第 3 步在数据库层拒绝余额不足的正常核销。平台角色仍由
第 1 步的 schema 总封锁隔离。旧版第 2 步若报 default privileges 权限错误，不会
回滚第 1 步；新建查询执行最新版第 2 步。本迁移不修改云函数代码，因此不产生新 ZIP。

## 064 正常／体验核销自选次数

063 全部验收为 `READY` 后，按 [`064-README.md`](064-README.md) 在短暂停止
核销写入的窗口执行：

1. 整文件执行 `064-01-variable-verification-unit-count.sql`；
2. 立即上传 `faceRecognition-v98.zip` 并用 `health` 确认 `version=v98`；
3. 整文件执行 `064-readonly-verify.sql`，8 行必须全部为
   `record_count=0`、`status=READY`；
4. 再发布本提交的网页版和小程序，并分别验证多次正常核销、多次体验核销、
   余额／额度不足、重复提交和超时恢复。

064 把主核销记录与体验额度流水的次数约束改为 `1—999`，数据库事务按办理人员
所选次数原子扣减。旧函数签名会明确拒绝写入，避免旧客户端继续静默按 1 次建单。

## 065 门店业务老师统一为可选

064 验收完成后，按 [`065-README.md`](065-README.md) 执行：

1. 短暂停止充值、退费、核销和产品购买的新建操作；
2. 整文件执行 `065-01-store-optional-business-teacher.sql`；
3. 继续执行 066；旧版 066 曾建立第三张设备注册表时先运行 `066-02-retire-legacy-device-registry.sql`。随后在低峰期执行 067，再上传 `faceRecognition-v109.zip` 并用 `health` 确认 `version=v109`；
4. 执行 `065-readonly-verify.sql`，9 行必须全部为
   `record_count=0`、`status=READY`；
5. 上传小程序 `0.2.39` 开发版并做门店留空老师／选择老师、老师自动归本人验收。

065 让门店的充值、退费、正常核销和独立产品购买都允许不指定业务老师；只有
选中老师时才校验并产生老师统计、客户关系和历史归属。老师账号仍强制绑定本人，
门店体验核销仍然拒绝。迁移同时退役旧必选约束，并使空老师核销能安全写入设备
信号和通过防重恢复。

## 066 BLE 核销资格与一次性设备授权

065 验收完成后，按 [`066-README.md`](066-README.md) 执行：

1. 短暂停止正常核销和体验核销新建，整文件执行
   `066-01-ble-verification-authorization.sql`；
2. 不建立设备注册表、设备主档、数据库设备白名单或配对码表；执行过旧三表版 066 的环境先运行 `066-02-retire-legacy-device-registry.sql` 清理退役表。二维码序列号和六位码仅用于当次扫码，实时设备信息必须由 BLE `get_info` 读取；
3. 在 `faceRecognition` 环境变量和设备安全存储配置同一份独立的 `BLE_AUTH_SIGNING_KEY`；
4. 按 [`067-README.md`](067-README.md) 在低峰期建立大数据充值／退费查询索引，然后上传 `faceRecognition-v109.zip` 并确认 `health version=v109`；
5. 执行 `066-readonly-verify.sql`，11 行必须全部为 `READY`，并确认 `BLE device registry absent` 为 `READY`；
6. 用真机验收人脸通过后的 90 秒扫码资格、关闭／重开、蓝牙与协议错误不扣次、
   设备状态 `2` 才扣次建单，以及成功后永久关闭扫码窗口并跳转精确工单。

066 不改变现有核销原子写入。它只把写入推迟到登记设备完成一次性授权并回报工作
状态之后；任意扫码、蓝牙、网络、设备或协议失败都不得提前扣减余额／体验额度。
协议 V2.0 的设备回执尚无设备侧签名，属于已记录的剩余风险；固件 V2.1 应增加
设备 HMAC／签名回执与重放保护。

## 067 大数据充值／退费查询性能

066 验收完成后，按 [`067-README.md`](067-README.md) 在业务低峰期执行：

1. 暂停充值、退费写入以及总部充值／退费查询；
2. 整文件执行 `067-01-refund-query-performance.sql`，为门店、类型、状态、项目、提交时间和游标建立组合索引；
3. 执行 `067-readonly-verify.sql`，确认四个索引有效；
4. 上传 `faceRecognition-v109.zip`，用 `health` 确认版本后，分别验收“今天”和“全部时间”的总部退费查询及翻页。

067 不修改业务数据。配套 v109 会先在业务表筛选、计数和分页，再联接当前页展示资料；历史工单按工单自己的办理门店查询，不再被客户最初建档门店误排除。

## 068 正常／体验核销客户评价

067 验收完成后，按 [`068-README.md`](068-README.md) 执行：

1. 整文件执行 `068-01-customer-work-order-ratings.sql`；
2. 执行 `068-readonly-verify.sql`，9 行必须全部为 `READY`；
3. 配置 `CUSTOMER_RATING_SIGNING_KEY`、实际 `rating.html` 完整 HTTPS 地址 `CUSTOMER_RATING_BASE_URL`，并完成匿名登录、匿名角色云函数网关权限和 `customerRating` 的 `"auth != null"` 调用规则；
4. 上传 `customerRating-v4.zip`，确认 `health` 返回 `version=v4`、`configured=true`，再发布含 `rating.html` 的静态网页和当前小程序开发版本。

068 只新增每张已完成正常／体验核销唯一、一次提交、不可删除的客户评价，不修改核销、人脸、照片、BLE、余额或体验额度。总部和工单所属门店导出凭证可带评价二维码，老师导出保持无二维码原版。

### 048 在当前控制台报 `unterminated dollar-quoted string`

部分 CloudBase SQL 编辑器会在约 4KB 时截断粘贴内容；这不是数据库函数语法
错误。不要反复执行被截断的原 `048-03`／`048-04` 文件。改用
[`048-4kb/README.md`](048-4kb/README.md) 的独立事务包，每个文件在 Windows
换行符下也不超过 3.5KB。

如果已经确认 `048-02` 和 `048-03` 成功、但 `048-04` 报此错误，先在新查询中
单独执行 `ROLLBACK;`，然后只按该 README 的现场恢复顺序执行 `09-01`、`09-02`、
`10`、`11`、`12`、`13` 和只读的 `14`。其中 `09-02` 会安全替换体验额度独立
充值函数；不会删除老师、客户、产品、额度或历史流水。

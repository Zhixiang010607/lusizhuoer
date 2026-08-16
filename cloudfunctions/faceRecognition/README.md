# faceRecognition 云函数

该函数仅在 CloudBase 后端运行，用于门店客户建档、照片质量检测、私有照片留存、人脸人员库录入和后续人员搜索。客户不需要提供身份证。

当前版本：`2026-08-17-multiple-customer-profiles-v26`

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
- `CUSTOMER_PHOTO_URL_TTL_SECONDS=120`：核销／充值选择客户时，私有照片临时地址的有效秒数；允许 30--600 秒。

## 拍摄和质量要求

- 浏览器内部保存为 JPEG 3:4 竖图，最长边不超过 1280 px；页面预览仍为正方形。
- 图片只能有一张人脸，人脸宽和高均至少 100 px。
- 不允许口罩、闭眼、明显低头、歪头或侧脸。
- 后端会再次执行质量检测，不能依赖前端结果。
- `CreatePerson` 使用算法模型 3.0、`QualityControl=3`、`UniquePersonControl=0`。
- 同一自然人可以建立多个独立客户档案；每次建档都会生成不同的客户编号和腾讯人脸 `PersonId`。系统不会按人脸、姓名或生日阻止重复建档。
- 页面为每次明确的新建档操作生成 `clientRequestId`；同一次提交因网络超时而重试时返回原客户档案，不会误建第二条。重新拍照或修改资料后再次提交会生成新的客户编号。
- 核销必须先选中具体客户编号，再使用该档案绑定的 `PersonId` 做 1:1 人脸验证，因此多个档案不会在核销时互相替代。
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
  "version": "2026-08-17-multiple-customer-profiles-v26",
  "photoBucketId": "customer-photos",
  "livenessEnabled": true
}
```

## 支持的动作

- `validateCapture`：拍照后立即检查单人、人脸尺寸、质量、口罩、闭眼和姿态。
- `registerCustomer`：服务端质量检查、可选活体检测，然后以新的唯一客户编号和 `PersonId` 入人员库、上传私有照片并写客户表。同一张脸、相同姓名或相同生日都允许建立新的独立客户档案。
- `listActiveStoreCustomers`：根据当前 CloudBase 登录账号在服务端解析真实门店，只返回该门店 `customer_status='ACTIVE'` 客户的编号、姓名和生日。下拉框不会预取备注、照片、状态或业务汇总。
- `listActiveTeachers`：仅允许活跃门店账号调用，从 `teachers` 与 `staff_accounts` 联表读取“老师资料活跃且登录账号活跃”的真实老师。正常核销、补录核销和充值页面不再生成演示老师；数据库无记录时下拉框保持空。
- `listActiveProducts`：仅允许活跃门店账号调用，只返回数据库中 `product_status='ACTIVE'` 产品的内部 ID、编号和名称；不会预取介绍、类别或任何价格字段。
- `createRechargeApplication`：只创建一张 `NEW`、`PENDING` 的真实充值单，并使用 `idempotency_key` 防止双击或网络重试重复建单。业务老师可以为空；选择老师时仍校验老师资料和登录账号均为活跃。提交待审核单不会增加客户充值次数；只有审核把同一张单改为 `APPROVED` 后，数据库汇总触发器才会计入次数。部署前依次确认已执行迁移 `021_customer_product_effective_balances.sql`、`023_recharge_pending_submission.sql` 和 `024_optional_recharge_teacher.sql`。
- `getActiveStoreCustomerDetail`：客户在下拉框中被选中后才调用；重新确认客户仍为本门店活跃客户，再返回完整客户资料和私有照片短时签名地址。短时地址会在安全有效期内由页面与云函数温实例复用，避免重复签名和重复查询；每次返回前仍先执行当前门店权限校验。
- `getCustomerPhotoUrl`：总部可读取任意客户、门店只可读取本门店客户；验证权限后为私有建档照片生成短时有效的签名地址。客户主页使用此动作，浏览器不能直接使用数据库中的 `pg://` 引用。
  - 兼容旧版本曾保存的重复桶名前缀（例如 `pg://bucket/bucket/path`）：读取时自动尝试两个合法对象名，成功后把数据库引用规范化。
  - 兼容 CloudBase `signObject` 的直接／包装返回结构；单对象接口未返回 URL 时自动使用 `signObjects` 复核，并继续尝试旧照片路径。
  - 若两个路径都不存在，返回 `CUSTOMER_PHOTO_OBJECT_MISSING`，该客户需要重新采集照片；不会把底层存储错误直接暴露给页面。
- `getCustomerProductBalances`：验证当前门店账号和客户归属后，读取该客户按产品汇总的购买次数、有效核销次数和剩余次数；体验与作废核销不消耗余额。
- `getCustomerStatus`：总部可读取任意客户、门店只可读取本门店客户的资料与当前活跃／封存状态；返回客户姓名、生日、备注、建立时间，以及关联门店的真实名称和门店编号。
- `updateCustomerStatus`：总部或客户所属门店把同一客户档案在 `ACTIVE` 与 `ARCHIVED` 之间切换；只更新状态和更新时间，不删除照片、面容档案或历史工单。
- `searchCustomer`：质量检查、可选活体检测、人员搜索、阈值和候选分差判断，再从本门店客户表返回档案。

正式上线前还要提供客户授权记录、照片与人脸数据删除流程、访问审计，并确认腾讯云高精度静态活体服务已开通和计费。

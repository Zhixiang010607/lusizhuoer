# faceRecognition 云函数

该函数仅在 CloudBase 后端运行，用于门店与老师共享的客户建档、照片质量检测、私有照片留存、人脸人员库录入、1:1 核验和业务数据接口。总部只保留查询、审核、管理与已有记录读取，不能新建客户或业务工单。客户不需要提供身份证。核销单照片的列表、原图、导出及三个补充照片位上传已拆到独立的 `verificationPhoto v10`；当前静态前端不再把这些照片动作发给本函数。

当前版本：`v109`

`v109` 修复门店全局视图加载失败：门店客户状态查询改为仅接受 `ACTIVE`／`ARCHIVED` 的白名单 SQL helper，移除对不存在的 `sqlLiteral` 的调用；其余业务接口、权限与统计口径保持不变。

`v108` 同时修复大数据量下的充值／退费查询：汇总和计数先在业务表上完成，只有姓名／生日精确查询才联接客户表；明细先按条件排序、分页，再只为当前页联接客户、门店、项目和老师。门店业务明细、活跃／封存客户、老师客户与工作台列表也统一先计数再取当前页，页码超出时自动夹取并重读最后有效页，避免重复提交、空白页和前端错乱。历史工单按工单自己的办理门店查询，不再错误要求它等于客户最初建档门店。压力数据环境必须先执行 067 的四个游标索引，再部署本版本。

v108 与 `verificationPhoto v10` 共享同一份经过权限校验的照片服务实现，但由启动模式限制可调用动作。`faceRecognition` 保留人脸 SDK 和人脸／业务动作；`verificationPhoto` 的部署包不安装腾讯人脸 SDK，也拒绝所有人脸、客户、充值和建单动作。部署和环境变量详见 `../verificationPhoto/README.md`。

v108 修正门店与老师核销时偶发无法选择客户的问题：活跃客户第一页读到后即可选择，后续分页只追加和去重，不得清空已经选中的客户；后续页失败时保留已读客户并允许重试。BLE 资格在设备授权真正签发前属于可放弃状态，允许重新选择门店和客户；只有仍有效的 `ISSUED` 或 `DEVICE_WORKING` 设备授权才锁定原客户和设备。失败、过期或仅完成人脸但尚未签发设备授权的记录不得隐藏客户选择器，90 秒有效期一律以数据库时间为准。

v108 在 PostgreSQL 查询结果离开云函数前统一规范化 `*_at`、`*_time` 与 `*_date` 字段，并把门店可办理的充值、退费、正常核销和独立产品购买统一为“业务老师可选”。门店留空时工单不归属老师；主动选择时，服务端必须验证老师主档和登录账号均为活跃后才写入归属。老师账号办理上述业务时仍由服务端强制绑定当前老师本人，不能改选其他老师；体验核销仍只允许老师本人办理，门店始终禁止。

v108 同时修正客户主页的历史统计口径：客户抬头和逐项目“累计充值”只汇总审核通过的 `NEW` 充值原始次数，审核通过的 `REFUND` 作为“累计退费”单独返回；退费不会倒减历史累计充值。逐项目“剩余”仍读取 `customer_product_balances.remaining_count` 的净余额，退费额度与余额风控也继续使用数据库净口径，不能用历史累计充值放宽可退额度。总部工作台原有充值／退费事件分列保持不变。

v108 修复 BLE 资格写入后直接读取空结果导致的 `verification_id` TypeError：服务端现在先按幂等键写入，再按同一幂等键回查资格；未读到完整资格时返回受控错误且不扣次。缺少或不足 32 字节的 `BLE_AUTH_SIGNING_KEY` 会在创建 90 秒资格前被拒绝，小程序只显示简短中文反馈，不显示底层 SQL、TypeError 或堆栈。

v108 最终取消设备注册表依赖。数据库只保留 `verification_ble_qualifications` 与 `verification_ble_authorizations` 两张短时资格／授权审计表；云函数不再查询设备主档、数据库设备白名单、预登记状态或配对码哈希。设备身份由二维码序列号、实时 BLE `get_info` 返回值、每次新 nonce、90／30 秒窗口和 HMAC-SHA256 共享密钥共同校验。

## 必需环境变量

- `FACE_SECRET_ID`
- `FACE_SECRET_KEY`
- `FACE_GROUP_ID=lusizhuoerdatabase`
- `CLOUDBASE_ENV_ID=rusizhuoer-d9gbcsgym07651694`：必须与 PostgreSQL 实例、PG 云存储桶和下面的 service role key 属于同一个 CloudBase 环境；运行平台已可靠注入同值 `TCB_ENV` 时可由它替代。
- `CLOUDBASE_APIKEY`：平台托管的 CloudBase PG 云存储 service-role API Key，只能保存在云函数环境变量中。代码仍兼容旧变量 `CLOUDBASE_SERVICE_ROLE_KEY`；两者同时存在时优先使用 `CLOUDBASE_APIKEY`。
- `BLE_AUTH_SIGNING_KEY`：BLE 一次性授权使用的 **HMAC-SHA256 完整性与身份验证密钥**，不是内容加密密钥，也不是门店／老师填写项。建议在离线可信终端执行 `openssl rand -hex 32` 生成 32 随机字节（显示为 64 个十六进制字符）。同一个值必须分别写入 `faceRecognition` 云函数环境变量和设备安全存储／受保护固件配置；不得写入小程序、二维码、聊天、README、GitHub，也不得与 AppSecret、API Key、照片清理令牌或二维码六位验证码复用。二维码六位码只是非秘密的现场会话字段，不是密钥，也不会保存到设备注册表（系统不存在该表）。

不要把腾讯云密钥写入前端 JavaScript、README 或 GitHub。

`faceRecognition` 与 `verificationPhoto` 必须在各自函数的环境变量页面分开配置；每个变量名称和值各占一行／一个输入项。不要把整段 `KEY=value` 文本、其他变量名、引号或换行一起粘进某一个变量值。两个函数使用同一个安全随机、至少 32 位的 `VERIFICATION_PHOTO_CLEANUP_TOKEN`，但该值只存在环境变量中，不写进 triggers-only 配置。

## 老师与门店工作台（v108）

新建老师只调用独立的 `teacherCreate v6/createTeacher`，该函数只创建账号和老师
主档，不接收图片或建立老师人脸。`faceRecognition v109` 不接受老师创建、照片检测、
补录、替换、回读、回滚或最终清理委托，也不读取迁移 051 的老师人脸操作租约。

v108 允许门店和老师办理正常核销，体验核销只允许老师账号。正常核销和体验核销都要求办理人员明确选择 1—999 次，次数进入幂等匹配；数据库按同一次数原子校验并扣减客户余额或老师体验额度，设备信号只读取数据库确认后的次数。两类核销都调用同一个 `verifyCustomerFace` 与 `persistVerifiedFaceEvidence`，现场只对所选客户的 `PersonId` 做 1:1 比对。门店充值、退费、正常核销和独立产品购买的业务老师全部可选；留空时不写老师归属，选择时必须是一位主档及登录账号均活跃的真实老师。老师账号的充值、退费、正常核销、体验核销和独立产品购买都由服务端自动绑定本人并拒绝改绑。有效 `teacher_id` 是老师统计、老师客户关系和历史业务老师显示的归属依据；门店提交时老师不必是提交账号，老师账号提交时则必须与该 `teacher_id` 为同一人，总部和退役角色的旧字段不构成归属。

v99 将门店和老师所有办理页共用的活跃客户精确查询统一为“姓名或生日至少一项”：只传姓名时按姓名精确匹配，只传生日时按生日精确匹配，两项都传时同时匹配。查询范围仍由当前 UID 和已确认门店锁定为活跃客户；匹配结果继续使用稳定游标分页，客户端必须读完并在多位结果中按客户编号明确选择。两项都不传仍表示全量活跃客户下拉框读取，不会扩大账号门店权限。

v99 的充值流程支持第三步可选产品赠予：只读取迁移 060 中当前为 `ACTIVE` 的独立产品，按“选择产品 → 1—999 数量 → 点＋加入”形成最多 20 种且不重复的清单；退费拒绝赠品。迁移 061 让充值主记录与赠品明细在同一条数据库语句中原子写入，明细固定绑定父单的门店、客户和业务老师，并固化产品编号、名称与数量。赠品写入后不可修改或删除，也不改变库存、客户项目余额、核销、体验额度或统计。

v108 延续迁移 062 的独立产品购买提交并应用迁移 065 的老师归属规则：门店账号自动锁定本店，业务老师可留空或选择一位真实活跃老师；老师账号在业务页选择活跃门店并自动绑定本人。两者都从激活 `retail_products` 选择产品、填写 1—999 件数量，不采集人脸。购买单以 `PRODUCT_PURCHASE` 独立防重恢复，总部不能调用提交动作。客户主页三列产品汇总只累计审核通过的购买件数和父充值已通过的赠品件数。

v99 的客户主页历史接口提供五个独立查询范围：`RECHARGE` 只返回 `recharge_type=NEW`，`REFUND` 只返回 `recharge_type=REFUND`，`VERIFICATION`、`EXPERIENCE` 与 `PRODUCT_PURCHASE` 分别返回正常核销、体验核销和产品购买工单；五类各自返回独立稳定游标。网页与小程序不能把不同业务混入同一批记录后只依赖前端改标签。

v99 的 `recoverBusinessSubmission` 仅允许原提交账号、原门店按同一 `clientRequestId`
恢复充值、退费、产品购买、正常核销或体验核销结果。网页在调用结果丢失时会持久化锁定该请求，先查询
数据库中的既有工单；未知状态下不会生成新编号或再次扣次。前端只持久化不含明文客户资料、留言或人脸令牌的请求指纹；成功锁要等对应详情页真实加载并核对同一请求编号后才清除。部署 v108 前必须先执行迁移 058、063、064、065、066 和 067，
恢复当前业务规则对应的状态机与不可变审计字段触发器。

老师工作台的 `getTeacherWorkspace` 提供四类有效业务视图（核销、充值、体验、退费）、上海业务日期范围、按项目汇总矩阵，以及当前老师所有活跃项目的体验剩余次数。`getTeacherBusinessCustomers` 按“本人账号创建，或本人被有效 `teacher_id` 归属的已通过 `NORMAL`／`EXPERIENCE`／`NEW`／`REFUND` 业务”建立客户关系，并分别分页返回活跃用户与封存用户；列表充值次数只累计 `NEW`，核销次数只累计 `NORMAL`。老师业务列表和统计按工单 `teacher_id` 归属，因此门店选择该老师办理的有效业务也计入；门店来源仅接受充值、退费和正常核销，老师来源仅接受提交账号本人办理的充值、退费、正常核销和体验核销。历史总部、已退役 `operation`、老师身份不匹配、门店体验或补录核销的旧字段不会进入老师统计、客户关系、直接照片读取或历史老师显示，但原工单仍保留在总量与审计历史中。迁移 057 为新客户保存实际 `created_by_account_id`；门店账号创建的客户记录门店账号，不会直接绑定老师。取得客户关系后，老师可以读取客户主页、私有建档照、备注、留言，以及该客户由任何老师或门店提交的充值、退费、正常核销、体验核销详情和核销照片；`submitted_by_account_id` 仍是改单、补充照片、作废、撤销和提交恢复的唯一写权限依据，被选择为业务老师不获得他人提交工单的写权限。老师仍不能访问无关客户或修改客户状态。门店主页按客户 `created_store_id` 分别分页返回活跃与封存用户。老师与门店都把业务明细紧接在汇总下方，顶部日期按钮同时控制汇总和四类明细；明细使用服务端页码分页，响应包含 `total`、`page`、`pageSize` 和 `totalPages`，并保留上一页、下一页和直接跳页。`queryStoreBusinessRecords` 仍兼容旧查询页的游标方式，但页码与游标不能混用。门店业务办理区不显示体验入口，服务端也拒绝门店创建体验；老师在该门店完成的历史体验只作为审计数据保留在汇总与客户历史。门店业务区与老师业务区共用响应式版式，但不显示老师体验额度卡。门店全历史查询必须显式提交 `allTime=true`，避免缺省日期被误解为全历史；自定义范围仍最多 366 天。列表和汇总只统计 `APPROVED` 记录；账号身份、时间范围和分页参数均由服务端校验。迁移 055 同时移除订单触发器和核销主体锁中的旧老师人脸门禁；迁移 056 消除体验核销写入函数的额度列名歧义；迁移 057 增加可空的客户创建账号外键和索引，历史客户不猜测回填。老师主档、账号、额度配置、客户档案照与客户现场 1:1 人脸校验仍然必须有效。

老师不再采集人脸。新体验单固定保存客户建档照和客户现场照；历史老师人脸体验单
继续按真实 `face_subject_type=TEACHER` 只读展示，不会伪改照片主体。

迁移 054 建立老师账号赠送、客户人脸验证的体验核销原子入口；迁移 059 首次固化老师归属矩阵，迁移 065 最终取代其中“门店正常核销老师必选”的旧规则，统一门店充值、退费、正常核销和独立产品购买老师可选，同时继续保留门店体验拒绝及老师账号只能绑定本人的边界。体验事务消费当前登录老师的体验额度、绑定客户两张人脸照片并写入设备开启信号，不读取或扣减客户购买余额。

体验办理页面只允许老师账号使用 `getTeacherExperienceEntitlements({ teacherId, storeId })`；服务端只返回当前登录老师本人额度并拒绝改绑。调用者、门店、老师、产品及产品额度配置都必须活跃；每项还返回不受月初重置影响的 `totalExperienceCount`，该累计值只统计来源可信、已通过且由该老师本人提交的体验核销。历史异常用量仍保留在实际额度余额和不可变用量流水中供审计，但不计入业务累计。封存主档或已删除的额度配置不能出现在新业务选择中，但历史工单和统计仍按事件保留。

## 推荐环境变量

- `FACE_QUALITY_THRESHOLD=70`：建档照片质量最低分。
- `FACE_VERIFY_THRESHOLD=60`：已选客户 1:1 核销最低相似度；同时要求腾讯云 `IsMatch=true`。
- `FACE_MAX_YAW=20`
- `FACE_MAX_PITCH=20`
- `FACE_MAX_ROLL=15`
- `FACE_LIVENESS_ENABLED=false`：未开通高精度静态活体服务前保持 `false`；开通后改为 `true`。
- `FACE_LIVENESS_THRESHOLD=40`：腾讯云高精度静态活体推荐阈值。
- `CUSTOMER_PHOTO_BUCKET_ID=customer-photos`
- `CUSTOMER_PHOTO_URL_TTL_SECONDS=120`：核销／充值选择客户时，私有照片临时地址的有效秒数；允许 30--600 秒。
- `VERIFICATION_PHOTO_BUCKET_ID=verification-photos`：可选的核销证据专用私有 PG 存储桶。也可以与 `CUSTOMER_PHOTO_BUCKET_ID` 一样都配置为现有的 `customer-photos`；v99 会去重候选桶，并在写入照片前查询当前 PostgreSQL 环境的 `storage.buckets`，只选择确实存在的桶 ID。两个云函数必须配置相同值。
- `VERIFICATION_PHOTO_URL_TTL_SECONDS=900`：核销缩略图和按需原图的签名地址有效秒数；允许 60--900 秒。默认 15 分钟以复用浏览器私有缓存，地址仍会过期且不会写入持久存储。
- `VERIFICATION_PHOTO_UPLOAD_TTL_SECONDS=600`：一次补充照片上传任务在业务层的有效秒数；允许 120--900 秒。到期后数据库拒绝提交并释放该核销单的单任务锁。取消／过期对象要等创建满安全等待期后再做最终清理。
- `VERIFICATION_FACE_EVIDENCE_TTL_MINUTES=30`：人脸比对通过后、正式提交核销单前的照片草稿有效分钟；允许 5--120 分钟。
- `VERIFICATION_PHOTO_CLEANUP_TOKEN`：至少 32 位随机清理凭证，只放云函数环境变量；仅供控制台／管理端手工补跑，不写入定时触发器配置。

## 拍摄和质量要求

- 核销人脸凭证保存为 JPEG 3:4 竖图，最长边优先保留到 1920 px、质量系数 0.92；仅在超过 3 MB 时逐级缩小。另生成最长边 480 px、最多 384 KB 的独立缩略图。原图和缩略图的 Base64 合计稳定低于云函数 6 MB 同步事件上限，详情页不会为了列表预览下载原图。
- 图片只能有一张人脸，人脸宽和高均至少 100 px。
- 不允许口罩、闭眼、明显低头、歪头或侧脸。
- 后端会再次执行质量检测，不能依赖前端结果。
- `CreatePerson` 使用算法模型 3.0、`QualityControl=3`、`UniquePersonControl=0`。
- 同一自然人可以建立多个独立客户档案；每次建档都会生成不同的客户编号和腾讯人脸 `PersonId`。系统不会按人脸、姓名或生日阻止重复建档。
- 页面为每次明确的新建档操作生成 `clientRequestId`；同一次提交因网络超时而重试时返回原客户档案，不会误建第二条。重新拍照或修改资料后再次提交会生成新的客户编号。
- 核销必须先选中具体客户编号，再使用该档案绑定的 `PersonId` 做 1:1 人脸验证，因此多个档案不会在核销时互相替代。
- 已经选择客户的核销只调用 `VerifyFace`，现场照片只与数据库中该客户的 `PersonId` 做 1:1 比对，不搜索其他客户。
- 人脸比对通过后，现场原图和缩略图立即写入私有核销照片桶并生成短时证据令牌；正式建单时数据库在同一个事务中消费令牌并把不可修改的人脸照片绑定到核销单。上传或绑定失败时不得建单。
- 系统不提供 `SearchPersons` 或其他 1:N 查人入口。必须先按业务编号选定客户或老师，再用该档案在数据库中绑定的 `PersonId` 调用 `VerifyFace` 做 1:1 比对。

## 云存储

- PG 存储桶：`customer-photos`
- 访问权限：私有
- 单文件限制：5 MB
- MIME 白名单：`image/jpeg`
- 对象路径：`<storeId>/<customerCode>/<timestamp>.jpg`

该桶不为 `anon` 或 `authenticated` 创建任何 RLS Policy，客户端访问默认拒绝；控制台因此显示“未配置 RLS、API 访问将被拒绝”属于预期状态。官方 `service_role` 具备 `BYPASSRLS`，只有配置同环境服务端 API Key 的云函数可以读写。不要为消除控制台提示把照片桶公开或给网页账号增加整桶权限。数据库保存 `pg://<bucketId>/<objectName>` 私有引用，不保存公开下载地址。

可以另建 PG 存储桶 `verification-photos` 以便分开管理和保留策略，但不是必需条件。v99 与 `verificationPhoto v10` 按 `VERIFICATION_PHOTO_BUCKET_ID`、`CUSTOMER_PHOTO_BUCKET_ID` 的顺序对候选桶去重，并在写入前用 `storage.buckets.id` 预检当前数据库环境中实际存在的桶；两个环境变量都填写 `customer-photos` 时只检查、使用这一个桶。如果候选桶都不存在，服务端直接返回 `PHOTO_BUCKET_NOT_FOUND`：

- 访问权限：私有；不要给 `anon` 或 `authenticated` 添加 SELECT/INSERT/UPDATE/DELETE Policy。
- 单文件限制：5 MB；MIME 白名单仅 `image/jpeg`。
- CORS：当前补充照片通过 `verificationPhoto` 云函数传输，不再要求浏览器 `PUT` CORS。保留正式静态站点所需的受限读取配置即可；不要使用 `*` 来源，也不要开放浏览器列桶、删除或覆盖权限。桶仍保持私有且不给 `anon`／`authenticated` 建 Policy。
- 对象路径：人脸凭证使用 `face-evidence/<store>/<staff>/<token>/...`，新版补充照片使用 `records/<verificationId>/slot-<n>/direct-<timestamp>-<server nonce>.jpg`；路径全部由云函数随机生成，浏览器输入不会进入路径，每次替换都使用新对象名且签名禁止覆盖。
- 每单固定展示 2 张人脸照片和 3 个补充照片位。迁移 054 后，正常核销与新体验核销的前两张都是客户登记照和客户现场照；迁移 049 至 053 期间生成的历史老师脸体验单继续标记为 `TEACHER` 并如实展示，不会把旧照片伪装成客户。补充照片只保存一份高清 JPEG，提交时服务端验证实际字节数、MIME、JPEG 文件头、真实尺寸和 SHA-256；缩略图由 CloudBase 图片处理按需生成。
- 当前网页固定调用独立的 `verificationPhoto v10`，其响应为 `uploadMode=FUNCTION`：数据库先建立／复用上传请求并锁定“每单一个进行中任务”，网页再把压缩 JPEG 和该任务的短时证明提交给函数；函数只能写入任务已锁定的同一桶和随机对象路径。这样不依赖浏览器 PUT 签名，取消、重试、提交人和 24 小时限制仍由迁移 039 原子函数控制。
- `faceRecognition v109` 暂时保留 v52 的 `DIRECT`／精确 `FUNCTION` 回退实现，供旧客户端平滑升级和共享服务测试；当前生产前端不调用这组兼容照片动作。两个函数均不会接受客户端指定的桶或对象路径。
- 原图和缩略图设置私有长期缓存；数据库从不保存签名 URL。详情首屏仅以最多 2 路并发准备 5 张缩略图，不提前签发 5 张高清原图；点击时才重新校验权限、写查看审计并取得该照片的短时原图地址。页面先显示缩略图，再无闪烁替换为高清图；同页重复查看可复用仍有效的私有地址，并把已解码原图限制为最多 2 张。
- 在本函数配置名为 `cleanup-verification-photo-drafts-hourly` 的每小时 Timer，只清除过期且未建单的人脸照片草稿。触发器使用 CloudBase `triggers` 配置，不携带 `action` 或清理凭证；v99 会严格验证平台保留的 `TRIGGER_SRC=timer`、函数名、事件类型、触发器名、时间和无终端用户 UID。取消／过期的迁移 039 补充照片任务由 `verificationPhoto` 的另一个 Timer 清理；两个触发器名不要互换。

## 部署

上传包文件名必须为 `faceRecognition-v109.zip`。把本目录中的 `index.js`、`package.json` 和 `README.md` 放在 ZIP 根目录；不要再套一层目录。函数入口为 `index.main`，部署时安装 `package.json` 依赖。交付前必须回读 ZIP 根目录的 README 与运行时代码，确认两者均为 `v109`。

在 `faceRecognition` 的触发器配置编辑器中填写以下完整配置。CloudBase 只接受顶层 `triggers` 数组；不要在这里填写业务事件、`action` 或 `cleanupToken`：

```json
{
  "triggers": [
    {
      "name": "cleanup-verification-photo-drafts-hourly",
      "type": "timer",
      "config": "0 0 * * * * *"
    }
  ]
}
```

该七段 Cron 每小时整点运行。需要从控制台手工补跑时，使用 `{ "action":"cleanupVerificationPhotoDrafts", "cleanupToken":"与环境变量完全一致的真实值" }`；手工入口仍要求至少 32 位凭证且调用中没有终端用户 UID，不能由普通网页账号调用。

首次上线迁移 039 时必须安排一个短暂停写窗口，并严格按下列顺序部署，避免旧页面绕过单任务锁：

1. 在完整 PostgreSQL migration 工具中执行 `database/migrations/039_direct_verification_photo_upload.sql`；腾讯云 SQL 编辑器则依次单独执行 `039-01`、`039-02`、`039-03`、`039-04`、`039-05`。
2. 执行 `database/migrations/040_fix_verification_photo_commit_ambiguity.sql`；腾讯云 SQL 编辑器只需执行一次 `040-01-fix-verification-photo-commit-ambiguity.sql`。已经完成 039 的生产库不要重跑 039。
3. 完成 046、总部封锁旧运营凭据、047 和 048 后，依次执行 `049-01` 至 `049-13`，再运行 `049-readonly-verify.sql`，全部必须为 `READY`。049 是向前迁移，不要修改或重跑生产已执行的 048。
4. 执行迁移 050 的 7 段控制台 SQL并确认只读验收全部 `READY`，再按 053 指引退役旧老师人脸 Saga。`faceRecognition v109` 不依赖迁移 051／052，也不需要老师人脸操作恢复 Timer。
5. 完整执行迁移 054（CloudBase SQL 编辑器使用 `054-01-teacher-only-customer-face-experience.sql`），把新体验核销切换为老师账号赠送、客户人脸凭证。
6. 将 `faceRecognition` 执行超时设为 **90 秒**；准备 `faceRecognition v109`、`verificationPhoto v10`、`staffAccount v80` 和 `teacherCreate v6`，但等 060—067 验收完成后再统一部署。`teacherCreate` 可设为 **60 秒、至少 256 MB**，且不再需要任何 FACE 或照片桶变量。
7. 完整执行迁移 055 并确认 3 行全部 `READY`，移除充值、退费、核销和体验核销中的旧老师人脸门禁；再执行 `056-01-experience-quota-column-ambiguity.sql`，确认返回 `READY`。
8. 执行 `057-01-teacher-created-customer-access.sql`，确认字段、外键和索引 3 行全部为 `READY`。
9. 按 `058-README.md` 执行三段 SQL，确认只读验收两行全部为 `READY`。
10. 按 `059-README.md` 先执行只读预检，再执行写入文件和只读验收，确认业务老师矩阵全部为 `READY`。
11. 按 060 README 建立独立产品主档，再按 061、062 README 建立并验收充值赠品明细与独立产品购买。
12. 确认 063 的 8 行安全验收全部为 `READY`；短暂停止核销写入，执行 064。随后按 065 README 短暂停止充值、退费、核销和产品购买新建并执行 065；继续整文件执行 066，并在云函数环境变量配置独立的 `BLE_AUTH_SIGNING_KEY`。066 不登记设备，只建立短时资格和授权审计。最后在低峰期按 067 README 建立充值／退费查询索引并完成只读验收。
13. 执行并验收 068，配置至少 32 字节的 `CUSTOMER_RATING_SIGNING_KEY` 及实际 `rating.html` 地址 `CUSTOMER_RATING_BASE_URL`，准备 `customerRating-v1.zip`。如果旧版 066 曾建立第三张设备注册表，先执行 `066-02-retire-legacy-device-registry.sql`；部署 `faceRecognition v109` 及同轮配套函数，分别调用 `health` 核对实际版本，再发布包含 `rating.html` 的网页和小程序并强制刷新。

当前切换顺序为“确认 048—050 与 053 已完成 → 依次执行并验收 054—065 → 执行 066 并配置 `BLE_AUTH_SIGNING_KEY` → 低峰期执行并验收 067 → 部署
`faceRecognition v109`、同轮配套的 `verificationPhoto v10`、`staffAccount v80`、`teacherCreate v6`、`customerRating v1` → 分别 health → 运行 065—068 只读验收 →
发布当前静态前端”。不要再发送任何老师人脸 action；新体验核销只能调用客户 1:1
人脸验证。

部署后测试：

```json
{ "action": "health" }
```

应返回：

```json
{
  "ok": true,
  "version": "v109",
  "photoBucketId": "customer-photos",
  "verificationPhotoBucketId": "verification-photos",
  "verificationPhotoFallbackBucketId": "customer-photos",
  "verificationPhotoUrlTtlSeconds": 900,
  "verificationPhotoUploadTtlSeconds": 600,
  "verificationPhotoCleanupConfigured": true,
  "verificationPhotoCleanupTimerTriggerName": "cleanup-verification-photo-drafts-hourly",
  "verificationPhotoServiceRoleKeyConfigured": true,
  "verificationPhotoBucketMetadataReady": true,
  "verificationPhotoServiceRoleStorageReady": true,
  "livenessEnabled": true
}
```

上例假设另建了 `verification-photos`。如果当前环境把 `VERIFICATION_PHOTO_BUCKET_ID` 与 `CUSTOMER_PHOTO_BUCKET_ID` 都配置为 `customer-photos`，健康检查中的 `photoBucketId`、`verificationPhotoBucketId` 和 `verificationPhotoFallbackBucketId` 都返回 `customer-photos` 才是正确结果。`health` 展示的是环境变量配置；部署前还必须在同一个 CloudBase 环境的 PostgreSQL SQL 编辑器执行以下只读检查，确认真实桶和迁移 039 都存在：

```sql
SELECT
  CURRENT_DATABASE() AS database_name,
  TO_REGCLASS('public.verification_photo_upload_requests') AS upload_request_table,
  EXISTS (
    SELECT 1
      FROM storage.buckets
     WHERE id = 'customer-photos'
  ) AS configured_bucket_exists;

SELECT id, name, public, file_size_limit, allowed_mime_types
  FROM storage.buckets
 WHERE id IN ('customer-photos')
 ORDER BY id;
```

对上述 `customer-photos` 配置，第一条应返回非空 `upload_request_table` 和 `configured_bucket_exists=true`，第二条应恰好返回一行 `customer-photos`，同时 `public=false`、`file_size_limit` 不少于 5242880（5 MB）、`allowed_mime_types` 为空或包含 `image/jpeg`。如果使用专用桶，把查询中的候选集合改为 `('verification-photos', 'customer-photos')`，并确认至少一个 ID 与两个云函数的环境变量逐字一致。SQL 不能核对云函数 API Key；还要确认 `CLOUDBASE_ENV_ID`、优先变量 `CLOUDBASE_APIKEY`（或兼容变量 `CLOUDBASE_SERVICE_ROLE_KEY`）和执行 SQL 的 PostgreSQL 实例都属于同一个 CloudBase 环境。两个 health 的 `verificationPhotoServiceRoleStorageReady=true` 会额外使用各自的服务端 Key 对真实桶执行只读 `listObjects`，可直接识别错环境、失效 Key 或权限异常；若为 `false`，查看同响应的错误码和请求 ID。

## 支持的动作

- `validateCapture`：拍照后立即检查单人、人脸尺寸、质量、口罩、闭眼和姿态。
- `registerCustomer`：服务端质量检查、可选活体检测，然后以新的唯一客户编号和 `PersonId` 入人员库、上传私有照片并写客户表。同一张脸、相同姓名或相同生日都允许建立新的独立客户档案。
- `getTeacherBusinessContext`：仅允许活跃老师账号调用，返回当前老师本人身份和可选择的活跃门店。老师必须先选择本次办理门店，后续每个业务动作都会由服务端重新校验老师身份与门店状态。
- `listActiveStoreCustomers`：门店账号按 UID 锁定自身门店；老师账号必须提交一个真实活跃门店 ID。只返回目标门店 `customer_status='ACTIVE'` 客户的编号、姓名和生日，不预取备注、状态或业务汇总。每批最多 100 位并按“姓名、生日、客户编号”稳定升序；响应在还有下一批时返回 `nextCursor={customerName,birthDate,customerCode}`，下一次请求把该对象原样放入 `cursor` 即可继续加载完整名单。旧请求不传 `cursor` 时仍从首批开始；`customerName` 与 `birthDate` 可单独传入精确匹配，也可同时传入取交集，游标必须与当前已传筛选字段一致且字段完整。
- `queryStoreCustomers`：总部与门店共用的真实客户查询。服务端先根据 CloudBase UID 验证活跃身份；总部可查看全部门店或选择一个真实门店，门店账号始终锁定到自身绑定门店，老师无权调用。结果使用 `(created_at,id)` 游标分页且每页最多 100 条，业务阶段、活跃／封存及总数均由数据库对完整筛选范围汇总。结果中的“核销次数”直接从已通过且 `verification_type='NORMAL'` 的正常核销重新汇总，不读取会同时包含体验的客户主档历史累计字段。
- `queryStoreBusinessRecords`：总部与门店共用的充值／核销查询。总部可查看全部门店或选择一个真实门店；门店范围只来自服务端 UID 绑定，浏览器不能扩大权限，老师无权调用。支持按项目、原单状态、核销类型、提交日期或客户姓名＋生日查询；充值记录另返回作废申请状态，核销记录只显示原单审核状态。列表按 `(submitted_at,id)` 游标分页且每页最多 100 条，顶部统计由数据库对完整筛选范围汇总。部署前应依次完成迁移 `026`--`036`，并执行 `033_hq_query_indexes.sql` 支撑总部跨门店查询。
- `getStoreDashboard`：总部与门店共用的真实门店主页。门店账号始终按当前 CloudBase UID 锁定自身绑定门店；总部必须提交一个真实数字门店 ID，服务端验证门店存在后返回该门店基础资料、项目累计和分页客户数据。老师无权调用，浏览器传入的门店编号不能扩大门店账号权限。项目累计将体验明确独立（不扣客户余额），分页客户列表的“核销次数”同样只累计已通过的 `NORMAL` 正常核销；并返回退费生效前是否已有付费核销、退费实际扣掉的客户余额、余额不足而未扣余的退款、历史冲销、原始应计余额和按客户×项目归零后的调整，避免把不同客户的余额跨人抵扣。该动作依赖迁移 `021_customer_product_effective_balances.sql` 的客户余额汇总；生产环境建议同时执行迁移 `031_store_dashboard_indexes.sql`。
- `listActiveTeachers`：门店账号读取全部活跃老师；老师账号只能得到当前登录老师本人。老师办理页的老师下拉框由此锁定，浏览器不能把工单绑定给其他老师。
- `listActiveProducts`：允许活跃门店或已选择活跃门店的老师调用，只返回数据库中 `product_status='ACTIVE'` 产品的内部 ID、编号和名称；不会预取介绍、类别或任何价格字段。
- `listActiveRetailProducts`：允许活跃门店或已选择活跃门店的老师调用，只返回迁移 060 中状态为 `ACTIVE` 的独立产品 ID、自动编号和名称，供充值第三步赠品选择；不返回封存产品。
- `createRechargeApplication`：只创建一张 `NEW`、`PENDING` 的真实充值或退费单，并使用 `idempotency_key` 防止双击或网络重试重复建单。门店办理时业务老师可选；老师办理时服务端强制绑定当前登录老师并拒绝其他老师 ID。正常充值可附带最多 20 行不重复的激活产品赠品，主记录和赠品由单条数据修改 CTE 原子写入；同一防重编号重试还会逐行核对赠品，不允许借重试改清单。退费拒绝赠品。提交待审核单不会增加客户充值次数；只有审核把同一张单改为 `APPROVED` 后，数据库汇总触发器才会计入次数，赠品本身不进入业务次数。部署前依次确认已执行迁移 `021_customer_product_effective_balances.sql`、`023_recharge_pending_submission.sql`、`024_optional_recharge_teacher.sql`、060 和 061。
- `createVerificationApplication`：门店与老师均支持正常核销；门店的业务老师可留空，选择时必须是一位真实活跃老师，老师账号则由服务端自动绑定本人。体验核销只允许老师账号，并同样绑定当前老师。调用者必须先确认目标门店活跃客户、有效业务条件并完成该客户的 1:1 人脸验证；服务端同时校验未过期、未消费、属于同一提交账号／门店／客户／人脸请求的照片令牌，并通过数据库函数原子创建工单、固化客户留存照引用、绑定本次人脸照片和设备信号。体验核销扣减当前老师的可用体验额度，不扣客户购买余额。系统不再提供补录核销入口。
- `getTeacherWorkspace`：仅允许活跃老师读取本人基础资料；本人业务列表和统计查询经过来源校验且 `teacher_id` 等于当前老师的已通过充值、退费、正常核销和体验核销，包含门店选择该老师办理的有效工单。有效业务同时建立老师客户关系；读取精确详情时，服务端先确认工单归属本人或该工单客户属于当前老师的有效客户关系，再允许查看同一客户由其他账号提交的历史。详情只显示来源可信的工单业务老师。被选择为业务老师不等于原提交人，任何改单、补照片或提交恢复仍只认 `submitted_by_account_id`。
- `getActiveStoreCustomerDetail`：客户在下拉框中被选中后才调用；重新确认客户仍为当前门店或老师所选门店的活跃客户，再返回办理流程需要的客户资料和私有照片短时签名地址。短时地址会在安全有效期内由页面与云函数温实例复用，避免重复签名和重复查询；每次返回前仍先执行当前登录身份和门店范围校验。
- `getCustomerProfile`：总部可读取任意客户、门店只可读取本门店客户；老师可读取当前老师账号亲自创建的客户，或本人已有已通过正常核销、体验核销、充值、退费任一关系的客户。余额直接读取汇总表，充值与核销历史各自先返回最近 50 条，后续使用 `(submitted_at,id)` 游标每批最多 100 条，避免一次返回整段历史。
- `getReviewCustomerProfile`：已随运营角色下线；总部审核页直接使用 `getCustomerProfile` 与审核详情入口，不再提供运营审核上下文接口。
- `getCustomerPhotoUrl`：总部可读取任意客户、门店只可读取本门店客户；老师可读取本人账号亲自创建或本人已有任一有效业务关系客户的照片。验证权限后为私有建档照片生成短时有效的签名地址。客户主页使用此动作，浏览器不能直接使用数据库中的 `pg://` 引用。
  - 兼容旧版本曾保存的重复桶名前缀（例如 `pg://bucket/bucket/path`）：读取时自动尝试两个合法对象名，成功后把数据库引用规范化。
  - 兼容 CloudBase `signObject` 的直接／包装返回结构；单对象接口未返回 URL 时自动使用 `signObjects` 复核，并继续尝试旧照片路径。
  - 若两个路径都不存在，返回 `CUSTOMER_PHOTO_OBJECT_MISSING`，该客户需要重新采集照片；不会把底层存储错误直接暴露给页面。
- `getCustomerProductBalances`：验证当前门店账号或老师所选门店和客户归属后，读取该客户按产品汇总的购买次数、有效核销次数和剩余次数；体验核销不消耗余额。核销不提供作废入口，如需纠正误核销必须提交充值工单补回次数。
- `getCustomerStatus`：总部可读取任意客户、门店只可读取本门店客户的资料与当前活跃／封存状态；返回客户姓名、生日、备注、建立时间，以及关联门店的真实名称和门店编号。
- `updateCustomerStatus`：总部或客户所属门店把同一客户档案在 `ACTIVE` 与 `ARCHIVED` 之间切换；只更新状态和更新时间，不删除照片、面容档案或历史工单。
- `getVerificationPhotos`：总部可查看全部核销照片，门店只能查看本店；老师对客户拥有有效关系后，可以只读查看该客户由其他老师提交的核销照片。一次仅返回最多 5 张短时缩略图（客户留存照、本次核销人脸照、3 张补充照）和服务端计算的上传权限；高清原图不在列表阶段签发，数据库也不保存任何签名地址。上传、替换和取消仍要求当前账号就是原提交账号并处于 24 小时窗口内。
- `getVerificationPhotoOriginalUrl`：用户实际点击后再次校验相同工单权限，复用或刷新该照片位的短时原图地址，并写入 `VIEW_ORIGINAL` 查看审计。
- `getVerificationPhotoExportData`：仅供当前工单导出使用；执行与原图查看相同的实时账号、工单权限和 `VIEW_ORIGINAL` 审计，然后由云函数使用服务端鉴权通道直接读取单张私有 JPEG，以最多 4 MB 的 Base64 返回，不依赖临时下载地址。网页优先复用本页已经加载或刚提交的原图 Blob，只有浏览器无法读取字节时才逐张调用该安全兜底；不要求公开存储桶，也不向未授权账号签发或代理照片。
- `beginVerificationPhotoUpload`：入参仅为 `recordId`、客户端幂等 `requestId`、照片位 `slot=2..4` 和压缩后 JPEG 的实际 `originalBytes`。服务端先验证当前登录账号确为工单提交人且仍在 24 小时内；新请求先按真实 `storage.buckets.id` 选择桶，再调用数据库原子函数建立／复用任务并取得单任务锁。每单数据库层最多一条 `UPLOADING`，跨标签页也不能同时传第二张；同一 `requestId` 重试返回同一任务，不重复计数。每单／提交人一小时最多建立 30 个新任务。当前网页在 `verificationPhoto v10` 调用该动作，固定收到 `uploadMode=FUNCTION`。
- `commitVerificationPhotoUpload`：`verificationPhoto v10` 要求网页发送 `recordId`、`requestId`、该次压缩 JPEG 和服务端绑定该请求／工单／提交人／照片位／字节／对象引用的短时 HMAC 证明。服务端只使用数据库请求中保存的对象引用和预期字节，不接受客户端桶、路径、尺寸或散列；它重新检查 JPEG、解析真实尺寸并计算 SHA-256，再由数据库函数锁定订单和请求，在同一事务中写照片、写审计并把任务改为 `COMMITTED`。本函数保留 DIRECT 兼容处理，但当前网页不使用。
- `cancelVerificationPhotoUpload`：入参为 `recordId`、`requestId`；仅提交人可取消自己的未提交任务。取消立刻释放“每单一个任务”锁，但对象等签名保守失效 3 小时后才由定时清理删除，防止迟到 PUT 复活孤儿文件。已经提交的任务不能撤回照片。
- `getVerificationPhotoUploadStatus`：入参为 `recordId`、`requestId`；仅提交人可读取，返回 `UPLOADING`／`COMMITTED`／`CANCELLED`／`EXPIRED` 及对象是否已经到达存储。用于断网或页面恢复，不签发查看权限，也不扩大工单范围。
- `verificationPhoto v10` 的 `originalUpload` 固定为 `null`，网页不得尝试 PUT；函数响应绝不包含 `CLOUDBASE_APIKEY` 或兼容变量 `CLOUDBASE_SERVICE_ROLE_KEY`，`thumbnailUpload` 固定为 `null`，因为缩略图由服务端图片处理生成。
- `uploadVerificationExtraPhoto`：仅用于“迁移 039 尚未执行”的旧版短时兼容。迁移 039 一旦存在，该旧入口立即返回 `PHOTO_UPLOAD_DIRECT_REQUIRED`，防止旧页面绕过单任务锁；它与受上传请求约束的新 `FUNCTION` 路径不是同一条路径，不可混用。
- v99 延续照片专用启动模式和动作白名单，不暴露任何老师人脸创建、补录、替换、回读、回滚、最终清理或体验核销比对动作。普通核销与老师赠送体验都只对所选客户执行 `VerifyFace` 1:1 比对；系统没有 `SearchPersons`／`searchCustomer` 1:N 入口。照片桶仍保持私有，所有列表、原图与导出读取仍先经过账号和工单权限校验。
- `cleanupVerificationPhotoDrafts`：平台 Timer 自动入口不接收业务参数或凭证，只在可信 SCF Timer 上清理过期未消费草稿；控制台手工入口仍使用恒定时间比较的专用随机凭证。两种入口都不删除已经绑定核销单的照片。

正式上线前还要提供客户授权记录、照片与人脸数据删除流程、访问审计，并确认腾讯云高精度静态活体服务已开通和计费。

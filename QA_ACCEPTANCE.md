# 页面、按钮与查询验收记录

更新日期：2026-08-25

本文件记录网页版与微信小程序的回归范围，避免把“代码存在”“自动化通过”“真实账号已操作”和“已发布”混为一谈。验收不记录客户、员工、手机号、密码、照片或工单号等真实资料。

## 结果标记

- `PASS-LIVE`：已在当前 CloudBase 真实数据会话中打开并操作，只执行只读查询、导出、重载、筛选、分页、页签、空表单校验或取消确认。
- `PASS-AUTO`：已由仓库契约测试覆盖角色、权限、查询参数、状态机、幂等、防越权和页面结构。
- `CONFIRM-ONLY`：封存、激活、审核、创建、充值、退费、核销、删除配置、修改密码等会改变真实数据的按钮只验到校验或确认边界，没有提交。
- `NEEDS-ROLE-LOGIN`：必须使用专用老师或门店测试账号才能完成真实角色会话验收；不允许通过重置现有员工密码或伪造会话代替。
- `NEEDS-CONSOLE-SETUP`：代码已具备入口，但平台身份源、合法域名、套餐或真机条件尚未完成。
- `FIXED-PENDING-DEPLOY`：真实线上验收发现问题，仓库已修复并通过本地回归，但静态网站尚未重新发布。
- `UPLOADED-EXPERIENCE`：代码包已上传为微信体验版，但尚未提交审核或正式发布。

## 网页版（36 个业务页面）

| 页面范围 | 页面、按钮与查询 | 结果 |
| --- | --- | --- |
| 登录与安全 | `login.html` 登录；`change-password.html` 密码规则、两次密码一致性与保存按钮 | 登录 `PASS-LIVE`；空密码校验 `PASS-LIVE`；真实改密 `CONFIRM-ONLY` |
| 总部首页 | `index.html` 日期周期、重置、4 项指标详情、6 个图表下钻、老师／产品／门店排名、分页、导出 | `PASS-LIVE` |
| 客户查询 | `customer-query.html` 姓名、生日、门店、业务阶段、状态、快捷筛选、重置、分页、进入详情 | `PASS-LIVE` |
| 客户详情 | `customer-detail.html` 资料、照片重读、备注校验、留言校验、余额与四类历史 | 读取与空值校验 `PASS-LIVE`；保存和封存／恢复 `CONFIRM-ONLY` |
| 充值查询与详情 | `recharge-query.html` 条件、状态、客户查询、重置、分页；`recharge-detail.html` 详情、PDF、图片 | `PASS-LIVE` |
| 核销查询与详情 | `verification-query.html` 条件、类型、客户查询、重置、分页；`verification-detail.html` 5 个照片位、原图、重读、PDF、图片、单张下载 | `PASS-LIVE`；总部无补照片写权限符合预期 |
| 审核 | `recharge-review.html`、`refund-review.html`、`verification-review.html` 的条件查询、工单查询、分页、详情入口、通过／驳回 | 查询 `PASS-LIVE`；审核决定 `CONFIRM-ONLY`；补录核销为历史兼容只读入口 |
| 产品管理 | `project-management.html`、`project-create.html`、`project-detail.html` 的查询、进入详情、模板 4 页签、刷新、样例下载 | `PASS-LIVE`；创建、保存、封存与上传 `CONFIRM-ONLY` |
| 门店管理 | `store-management.html` 名称与电话查询、新增入口、进入门店；`store-create.html` 表单；`store-detail.html` 时间范围、自定义日期、4 类业务页签、客户与统计 | 查询与只读操作 `PASS-LIVE`；创建和封存 `CONFIRM-ONLY` |
| 门店分析 | `store-analysis.html` 今天／近 7 日／本月及自定义日期查询 | 发现小写周期值失配；仓库已修复并增加运行时回归，`FIXED-PENDING-DEPLOY` |
| 老师管理 | `teacher-management.html` 姓名与电话查询、新增入口、账号详情、体验配置入口；`teacher-create.html` 必填与密码规则 | 查询、详情、历史展开和空表单校验 `PASS-LIVE`；创建、封存、密码重置、额度配置／删除／充值 `CONFIRM-ONLY` |
| 人员详情 | `staff-detail.html` 老师与总部两种资料、返回入口、账号安全、老师额度与历史 | `PASS-LIVE`；发现总部页面残留老师标题，仓库已改成随角色显示，`FIXED-PENDING-DEPLOY` |
| 总部人员 | `hq-management.html` 姓名／电话／直接选择查询、进入详情、新增入口；`hq-account-create.html` 创建表单 | 查询与详情 `PASS-LIVE`；创建、封存、重置密码 `CONFIRM-ONLY` |
| 一线共享办理 | `customer-create.html`、`recharge-create.html`、`refund-create.html`、`verification-create.html`、`verification-experience.html` | 页面结构、按钮启用条件、门店范围、老师归属、照片、人脸、额度与防重均 `PASS-AUTO`；真实提交 `NEEDS-ROLE-LOGIN` |
| 老师工作台 | `teacher-work-orders.html`、`teacher-work-order-detail.html`、`teacher-recharge-create.html`、`teacher-refund-create.html`、`teacher-verification-create.html`、`teacher-verification-experience.html` | 手机端基础信息仅姓名与短编号两项同排、不重复登录身份，体验项目单行、暖金配色，以及进入具体业务页后先选门店的路由、时间查询、4 类明细、客户范围、本人自动归属、体验仅老师均 `PASS-AUTO`；真实老师会话 `NEEDS-ROLE-LOGIN` |
| 兼容入口 | `teacher-detail.html` 旧详情链接 | 重定向到当前 `staff-detail.html`，`PASS-AUTO` |

## 微信小程序（19 个页面）

| 页面 | 页面、按钮与查询 | 结果 |
| --- | --- | --- |
| `pages/login/index` | 暖象牙白／浅香槟金品牌背景、弧形居中框、手机号＋密码、微信手机号登录、修改密码入口 | 既有总部账号密码登录与 UID／角色回读 `PASS-LIVE`；登录布局 `PASS-LIVE`；微信手机号授权 `NEEDS-CONSOLE-SETUP` |
| `pages/password-reset/index` | 短信验证码、新密码与确认、保存、返回登录 | 页面与既有账号改密契约 `PASS-AUTO`；真实短信发送与改密 `CONFIRM-ONLY` |
| `pages/home/index` | 总部“总／查／管／审／退”及六项指标、图表、排名；门店／老师时间范围、四类汇总、明细和客户；老师基础资料与体验项目紧凑单行 | 总部只读数据库会话 `PASS-LIVE`；三角色布局、老师主页不提前选门店、参数与旧响应隔离 `PASS-AUTO`；门店／老师真实角色会话 `NEEDS-ROLE-LOGIN` |
| `pages/product-management/index` | “全部产品”列表、产品名称进入模板、新增产品入口 | 专用流程与页面结构 `PASS-AUTO`；真实创建 `CONFIRM-ONLY` |
| `pages/product-create/index` | 产品名称、分类、说明和创建后直达模板 | 表单与创建后路由 `PASS-AUTO`；真实创建 `CONFIRM-ONLY` |
| `pages/product-detail/index` | 产品状态、共用原始 LOGO、两组说明、数据库回读、核销／充值 PDF 与图片四种真实预览和导出 | 与网页版单据排版、暖象牙品牌背景、A4 逐页 300 DPI、完整客户编号单行、长图相册保存、预览竞态和精简 LOGO 文案 `PASS-AUTO`；模板保存／状态修改 `CONFIRM-ONLY`；相册与文件分享需真机复验 |
| `pages/hq-directory/index` | 门店按名称／电话、老师按姓名／电话查询；查询结果、活跃／封存表格、独立新增与详情入口 | 总部真实只读目录会话 `PASS-LIVE`；老师四列满宽与等距留白、查询竞态 `PASS-AUTO`；新增与状态修改 `CONFIRM-ONLY` |
| `pages/store-create/index` | 门店名称、完整地址、多联系人和初始账号创建 | 表单、校验与服务端创建契约 `PASS-AUTO`；真实创建 `CONFIRM-ONLY` |
| `pages/store-detail/index` | 基础资料、时间范围、项目汇总、四类明细、分页、活跃／封存客户、总部状态操作 | 读取、精确跳转、布局与请求隔离 `PASS-AUTO`；真实写操作 `CONFIRM-ONLY`；门店角色会话 `NEEDS-ROLE-LOGIN` |
| `pages/teacher-create/index` | 姓名、手机号、初始密码，不采集老师人脸 | 创建字段、清理与回读契约 `PASS-AUTO`；真实创建 `CONFIRM-ONLY` |
| `pages/teacher-detail/index` | 档案、密码重置、状态、体验额度总览／配置／充值／删除和历史 | 读取、布局、权限与请求隔离 `PASS-AUTO`；额度、密码和状态写操作 `CONFIRM-ONLY` |
| `pages/reviews/index` | 充值／退费／历史补录核销查询、分页、跳页、工单／客户详情、通过／驳回 | 总部真实只读查询 `PASS-LIVE`；精确列宽、状态语义和旧响应隔离 `PASS-AUTO`；审核决定 `CONFIRM-ONLY` |
| `pages/customers/index` | 总部／门店客户范围、阶段、状态、日期、姓名／生日、分页、只读详情；姓名后紧接充值／核销，客户状态最后；老师不进入通用客户页 | 查询参数、角色边界、精确列序／列宽、横滑复位和请求隔离 `PASS-AUTO`；扩展条件需真实数据库复验 |
| `pages/customer-detail/index` | 资料和只读照片预览、产品余额、三类独立历史分页、备注、留言、状态、工单链接 | 基础读取 `PASS-LIVE`；无重读／相册按钮、名称精简、历史自适应列宽、照片失败隔离和旧响应隔离 `PASS-AUTO`；备注、留言与状态修改 `CONFIRM-ONLY` |
| `pages/customer-create/index` | 老师先选本次门店；姓名、生日、备注、现场照片、授权与提交 | 门店角色 UID 锁定、老师页内门店切换清空、上海日期、长度、人脸和整体成功契约 `PASS-AUTO`；真实建立 `NEEDS-ROLE-LOGIN` |
| `pages/recharge/index` | 老师先选本次门店；充值／退费、客户、项目、可选或自动老师、余额、留言、防重复恢复和详情跳转 | 门店切换清空、角色归属、余额旧响应隔离、幂等恢复和详情路由 `PASS-AUTO`；真实提交 `NEEDS-ROLE-LOGIN` |
| `pages/verification/index` | 老师先选本次门店；正常／体验、客户、项目、老师、五照片链路、人脸、额度、防重复恢复和详情跳转 | 门店切换清空、只验客户脸、角色边界、余额／令牌旧响应隔离、幂等恢复 `PASS-AUTO`；真实提交 `NEEDS-ROLE-LOGIN` |
| `pages/records/index` | 总部／门店充值与核销查询，门店、项目、类型、状态、日期、客户、分页和直接跳页；完整单号单行；审核汇总仅充值／退费显示 | 角色范围、核销无审核汇总、完整单号、完成状态语义、精确表格、请求快照和详情路由 `PASS-AUTO`；真实扩展筛选待复验 |
| `pages/order-detail/index` | 四类工单精确回读、完整单号单行、客户入口、五照片位、重试／补图、原图相册、PDF／图片导出 | 权限、类型校正、24 小时原提交人补图、暖象牙品牌背景、A4 逐页 300 DPI、客户姓名＋完整编号整行、照片 fail-closed、无核销审核时间和共享单据排版 `PASS-AUTO`；真实照片、相册、补图和导出需真机／专用账号复验 |

## 尚未冒充完成的事项

1. 老师和门店没有专用测试账号，因此尚未做这两个角色的真实登录逐按钮提交验收。完成该项需要提供两个可随时重置的测试账号，或明确授权创建专用测试账号；不得动现有员工账号。
2. CloudBase 小程序环境授权已成功，但 `WX_MICRO_APP`、微信公众平台 `request` 合法域名与真机微信手机号授权仍未完成。CloudBase 服务商域名入口本月修改额度已用完，不应继续重复提交；可直接在微信公众平台配置，或等额度恢复。
3. 小程序 `0.2.8` 已于 2026-08-25 上传为体验版，结果为 `UPLOADED-EXPERIENCE`；总包 `1,723,742` 字节、主包 `1,487,285` 字节。老师本人主页基础资料只保留姓名和短编号同排展示；总部进入老师主页后使用其他内部页面同款暖象牙白卡片、浅象牙内层和细金灰边框；额度变更记录在固定高度卡片内纵向滑动查看全部；每张已配置产品的四项额度信息使用居中放大的 `2×2` 网格。尚未提交微信审核或正式发布。本轮没有上传云函数、运行 SQL 或发布网站，代码推送与这些状态仍分别确认。
4. 2026-08-25 已在保持真实总部会话的微信开发者工具中重新执行 `build-npm`，并自动打开总部首页、产品／门店／老师管理及充值／核销审核页面；各只读数据库请求成功且未捕获页面异常。分包后又重新编译登录、门店详情、老师创建、充值和工单详情代表页，控制台没有模块、路由或分包错误。没有提交创建、封存、激活、审核或其他真实数据写入；这些按钮仍按 `CONFIRM-ONLY` 处理。

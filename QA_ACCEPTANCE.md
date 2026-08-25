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
| 老师工作台 | `teacher-work-orders.html`、`teacher-work-order-detail.html`、`teacher-recharge-create.html`、`teacher-refund-create.html`、`teacher-verification-create.html`、`teacher-verification-experience.html` | 路由、首页布局、时间查询、4 类明细、客户范围、本人自动归属、体验仅老师均 `PASS-AUTO`；真实老师会话 `NEEDS-ROLE-LOGIN` |
| 兼容入口 | `teacher-detail.html` 旧详情链接 | 重定向到当前 `staff-detail.html`，`PASS-AUTO` |

## 微信小程序（12 个页面）

| 页面 | 页面、按钮与查询 | 结果 |
| --- | --- | --- |
| `pages/login/index` | Logo 视觉衍生暖象牙白／浅香槟金背景、弧形居中框、“露思卓儿”原生文字、眼睛图标、手机号＋密码、圆角微信手机号登录、修改密码入口 | 既有账号密码登录及总部 UID／角色回读 `PASS-LIVE`；亮色 Logo 背景、框内文字、弧形布局、密码框右侧居中眼睛图标、微信圆角按钮文字双向居中和改密跳转均已在开发者工具重新构建并截图复验 `PASS-LIVE`；微信手机号授权 `NEEDS-CONSOLE-SETUP`（还需身份源、合法域名和真机） |
| `pages/password-reset/index` | 既有手机号短信验证码、新密码与确认、眼睛图标、保存、返回登录 | 页面路由、验证码按钮列宽、输入框和右侧眼睛图标已在开发者工具渲染截图复验 `PASS-LIVE`；不自动创建陌生 Auth 用户、验证码会话、密码规则、调用当前 UID 自助改密及完成后退出均 `PASS-AUTO`；真实短信发送与改密 `CONFIRM-ONLY` |
| `pages/home/index` | 三角色首页布局；总部“总／查／管／审／退”、日期、六项指标、动态刻度图表、排名维度、分页、跳页、重试、CSV 导出；门店／老师业务汇总和明细 | 总部真实 UID／角色会话下首页、6 项指标、3 张图、真实排名、老师维度切换和第 1 页跳转均 `PASS-LIVE`，无页面异常；菜单、日期、排名独立读取和导出契约 `PASS-AUTO`；CSV 分享弹窗未实际触发，写文件／分享仍需真机复验 |
| `pages/hq-directory/index` | 产品／门店／老师名称、编号、手机号查询，活跃／封存分区，新增表单，详情、老师体验额度、封存／激活 | 三类目录均在真实总部会话读取数据库且无页面异常，产品名称查询返回唯一匹配 `PASS-LIVE`；创建规则、独立老师创建云函数、状态回读确认和权限 `PASS-AUTO`；新增与状态写入 `CONFIRM-ONLY` |
| `pages/reviews/index` | 充值／退费／核销按门店与状态、精确工单查询，100 条分页、直接跳页、工单／客户详情、通过／驳回与可选留言 | 充值、退费和核销三类均已在真实总部会话完成数据库只读查询，充值完整工单号查询返回唯一匹配且无页面异常 `PASS-LIVE`（空结果同样按数据库真实返回处理）；分页、详情和审核参数 `PASS-AUTO`；审核决定 `CONFIRM-ONLY` |
| `pages/customers/index` | 总部门店范围、业务阶段、状态、建档日期、姓名／生日、汇总、清空、分页、直接跳页、详情入口；老师业务客户 | 原基础查询和详情入口 `PASS-LIVE`；扩展筛选、门店锁定、老师范围和游标直跳 `PASS-AUTO`；扩展页面待开发者工具重新登录后复验 |
| `pages/customer-detail/index` | 原图重读／保存、备注、余额、充值／核销／体验历史页签及工单详情链接 | 详情读取与历史页签 `PASS-LIVE`；工单链接 `PASS-AUTO`；保存类操作 `CONFIRM-ONLY` |
| `pages/customer-create/index` | 姓名、生日、备注、拍照、授权、提交 | 相机／授权／整体成功规则 `PASS-AUTO`；真实建立 `NEEDS-ROLE-LOGIN` |
| `pages/recharge/index` | 充值／退费、客户、项目、老师、次数、留言、防重复恢复 | 门店老师可选、老师自动绑定、门店锁定和防重 `PASS-AUTO`；真实提交 `NEEDS-ROLE-LOGIN` |
| `pages/verification/index` | 正常／体验、客户、项目、老师、照片、人脸、核销、防重复恢复 | 正常核销老师必选、体验仅老师、只验客户脸、额度原子扣减 `PASS-AUTO`；真实提交 `NEEDS-ROLE-LOGIN` |
| `pages/records/index` | 总部／门店充值与核销查询：门店、项目、类型、状态、日期、姓名／生日、汇总、分页和直接跳页 | 角色范围、筛选参数、页码分页和详情路由 `PASS-AUTO`；真实数据库页面待开发者工具重新登录后复验 |
| `pages/order-detail/index` | 总部／门店精确工单读取、老师关联工单读取、客户入口、核销照片原图预览与相册保存 | 精确鉴权参数、角色分流和照片读取 `PASS-AUTO`；真实数据库详情与照片待开发者工具重新登录后复验 |

## 尚未冒充完成的事项

1. 老师和门店没有专用测试账号，因此尚未做这两个角色的真实登录逐按钮提交验收。完成该项需要提供两个可随时重置的测试账号，或明确授权创建专用测试账号；不得动现有员工账号。
2. CloudBase 小程序环境授权已成功，但 `WX_MICRO_APP`、微信公众平台 `request` 合法域名与真机微信手机号授权仍未完成。CloudBase 服务商域名入口本月修改额度已用完，不应继续重复提交；可直接在微信公众平台配置，或等额度恢复。
3. 本轮没有上传云函数、运行 SQL、发布网站或上传／发布小程序。代码提交推送与上述发布状态必须分别确认。
4. 2026-08-25 已在保持真实总部会话的微信开发者工具中重新执行 `build-npm`，并自动打开总部首页、产品／门店／老师管理及充值／核销审核页面；各只读数据库请求成功且未捕获页面异常。没有提交创建、封存、激活、审核或其他真实数据写入；这些按钮仍按 `CONFIRM-ONLY` 处理。

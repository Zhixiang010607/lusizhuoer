# 2026-11-05 老师七项门店搜索与结果读取

老师七个入口均已接入同一门店搜索组件：客户建立、办卡充值、产品购买、退费申请、正常核销、补录核销、体验核销。名称关键词只筛选进入页面时服务端返回的活跃门店，不在输入时调用接口；必须点击真实结果才确认门店。结果保留原数组索引，避免筛选后选错门店；超过 50 个匹配可继续向下加载。门店账号保持绑定本店，不显示此控件，伪造切换事件也无效。

搜索仍位于原第一张业务卡。编辑、清除或改选会清空旧门店的客户、产品、老师、余额、人脸证据及草稿，递增异步请求代次；重复选择相同门店不清空。提交中、不确定锁、识别中或设备授权发出后的门禁继续生效。正常与体验核销的客户人脸、BLE、设备状态确认、次数预留和最终原子扣次路径未变。

同时修复三处原有问题：

- 老师“我的客户”链接传递详情实际接收的 `customerCode`，并仅允许当前列表内的客户链接。
- 补录详情仍严格校对 SUPPLEMENT 路由，但使用工作台已支持的 VERIFICATION 读取族；只有原单与原请求完全一致才确认原 SUPPLEMENT 提交。
- faceRecognition v138 恢复 SQL 按额度使用表真实主键 `verification_id` 读取；不再引用不存在的 `usage.id`。恢复失败保留原锁，不重提、不扣次，并隐藏该技术错误。

## 验证

`node --test tests/*.test.js`：672 项通过、0 失败。七个办理模式分别覆盖清除／重新选门店、无门店不请求、忙碌与门店角色保护；组件覆盖关键词、原始索引、无结果、123 个匹配、迟到源更新及禁用。客户链接实际进入详情 onLoad；补录三种状态使用支持的读取族、按原类型确认，权限失败或错类型不确认。

`tests/verify-business-submission-recovery-db.js` 使用临时 PGlite 运行真实 PostgreSQL，额度表直接取迁移 046 的定义：原 SQL 在空表也报 42703，修正 SQL 正常；待审／驳回／通过补录只回读原单，错误账号／门店／类型拒绝；正常核销仍要求信号，体验核销要求信号和真实额度记录。没有访问或修改生产数据库。

官方开发者工具运行隔离项目，四个真实业务页面及组件／依赖共 75 个生产文件与当前源码逐字节比对；API 和会话仅提供合成数据，不载入云 SDK，写操作拒绝。实际打开七个业务模式，检查 320／390／430 手机、768×1024／834×1112／1024×1366 iPad 及 1024×768 横屏。390 手机实际输入“广州”、筛选多个结果并点选海珠门店后启用客户确认。截图中的门店、老师及编号均为合成数据，不代表真实业务验收或生产发布。

| 尺寸及入口 | 原生效果 |
| --- | --- |
| 320 手机，客户建立 | [截图](assets/2026-11-05-teacher-store-search/phone-320-customer-create.png) |
| 430 手机，办卡充值 | [截图](assets/2026-11-05-teacher-store-search/phone-430-recharge.png) |
| 768 iPad，产品购买 | [截图](assets/2026-11-05-teacher-store-search/ipad-768-product-purchase.png) |
| 834 iPad，退费申请 | [截图](assets/2026-11-05-teacher-store-search/ipad-834-refund.png) |
| 1024 iPad，正常核销 | [截图](assets/2026-11-05-teacher-store-search/ipad-1024-normal.png) |
| 横屏 iPad，体验核销 | [截图](assets/2026-11-05-teacher-store-search/ipad-1024-landscape-experience.png)，[页面底部](assets/2026-11-05-teacher-store-search/ipad-1024-landscape-bottom.png) |
| 空门店列表 | [截图](assets/2026-11-05-teacher-store-search/ipad-empty-stores.png) |
| 读取失败与重试 | [截图](assets/2026-11-05-teacher-store-search/ipad-store-read-error.png) |

## 交付状态

没有新 SQL，无需用户执行 SQL。用户随后要求上传／部署：faceRecognition v138 已通过官方 DevTools 部署，health 与六文件下载比对通过；小程序开发版 0.3.53 已取得官方最终上传回执，用户确认补录正常。Web 未变，staffAccount 仍为 v98。体验版选择、微信审核与正式发布未独立确认。见 [0.3.53 回执](../../miniprogram-app/releases/0.3.53.md)。

`deployments/faceRecognition-v138.zip` 含六个根文件，已逐文件比对当前函数目录，README 当前版本、运行时 v138、package 138.0.0 与文件名一致；最终包 108801 字节，SHA-256 `0a2aeef5350154430bbfde0faffbf8e33e2218682a3e9361c2beaafb7b17fcaa`。首轮成功后，仅把 README 的打包时“尚未部署”说明换为外部回执引用，重新核验六文件包并按同一官方路径同步；运行代码和版本未改，随后 health 与六文件再次回下载一致。不重跑 088／089／090，不重新部署其余未变化函数。

# 老师创建与密码登录检查 · 2026-09-05

用户反馈添加老师账号及登录存在问题，并要求自行测试。

## 复现与修复

原来的密码登录在 Auth 返回成功后，立即调用 `staffAccount.session`；只有微信手机号登录启用了 SDK 会话刷新、UID 核对和有限重试。因此，当新认证会话尚未同步到随后的函数请求时，密码登录会把短暂的 `UNAUTHENTICATED`／`UNASSIGNED_IDENTITY` 当作最终失败并退出。

新增受控联调测试直接执行仓库 `teacherCreate` 创建逻辑及小程序 `session.js`，使用隔离的 Auth／数据库替身保留创建出的账号、初始密码和老师绑定，并模拟认证成功与业务请求令牌同步之间的延迟。修复前，“创建后遇到令牌延迟”“短暂身份回读失败”“认证返回缺少 UID”“SDK 身份不一致时不应发起业务读取”四个用例失败。

本次让两种登录方法统一走同一认证收尾：先验证 Auth 返回完整 UID，再刷新并核对 SDK 身份、按服务端 UID 读取角色。只对已有的两种短暂会话错误最多读取三次，间隔仍为 180／520 毫秒；不重复密码认证或微信 code 兑换，不传手机号绑定、不改账号、不扩大权限。错误密码、封存及身份不一致仍立即失败并清除会话。身份缺失现在返回明确的 `AUTH_RESPONSE_INCOMPLETE`，不再请求业务身份。

## 验证结果

- `node --check miniprogram-app/miniprogram/services/session.js` 通过。
- `node --test tests/*.test.js`：297 项全部通过；新增 8 项创建与登录联调检查，覆盖正常／延迟会话、短暂／持续失败、错误密码、缺少 UID、不同 UID 和封存账号。
- 官方微信开发者工具中运行隔离小程序，使用实际老师创建页与登录页控制器、WXML／WXSS、实际 `session.js`，模拟服务不连接生产环境。页面操作完整经过：空表单校验 → 输入示例老师及初始密码 → 提交创建 → 转到登录 → 错误密码被拒并清空 → 原初始密码登录 → 进入老师结果页，UID 与老师编号对应同一创建结果。
- [原生页面检查记录](assets/teacher-login-check/native-checks.json)、[结果截图](assets/teacher-login-check/native-success.png)。结果页仅为隔离检查落点，不替换生产工作台。
- 线上只读检查：`teacherCreate.health` 返回 `teacher-create-v6`、`ok=true`；下载源码与仓库仅有 CRLF／LF 差异，规范化换行后完全一致。现有老师的业务账号、老师主档与 Auth 均为 ACTIVE，UID 和手机号对应。没有发现该老师的缺失绑定。
- 当天的 CLI／SCF 日志查询均未返回记录，不能据此判断用户此前失败请求的具体原因，也不能把这次受控复现宣称为已取得该失败请求的生产证据。

## 验收边界与发布

本轮没有使用或重置真实老师密码，没有在生产新增、封存、删除或改绑账号，没有发送短信或调用真实微信手机号授权。线上只读检查与隔离完整流程共同用于定位和验证；尚未完成真实新老师在手机微信上的首次登录验收。

创建云函数、数据库、网页版和依赖未修改，无新 SQL、云函数 ZIP 或网页部署。修复位于小程序客户端；源码推送与微信版本上传分别记录。`0.2.65` 状态见[发布记录](../../miniprogram-app/releases/0.2.65.md)。

接口参数参考：[CloudBase 用户管理](https://docs.cloudbase.net/api-reference/manager/node/user)、[密码登录接口](https://docs.cloudbase.net/api-reference/webv3-next/authentication)。这些文档用于核对 API 契约，不作为上述令牌延迟生产事件的证据。

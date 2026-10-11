# 培训学习与发布通道验收

日期：2026-10-12（Australia/Sydney）

源码基线：`26cc6814ec28e8506b9849daea47143af22941b7`。

## 云函数

- 微信开发者工具官方 CLI 使用明确的 `cloudfunctions/staffAccount` 路径完成部署，回执 `success=true`、3 个文件、68.4 KB。
- 生产 `staffAccount/health` 返回 `ok=true`、`version=v93`、`managerNodeInstalled=true`。
- 下载生产代码回读后，核心三个文件与部署源完全一致：
  - `index.js`：`99466d0f0cc6643b30663a21ab6347ae4396c191296f4e31c19e954fe2163f10`。
  - `package.json`：`3a221fdaf7c66825e3cccc0760d6e38023096389c798796920c02e25efc7d9c3`。
  - `README.md`：`a77c65fbb7bc15bbf67874ecff7f83aeccbc4198a98e3624ba3abcf45611d9c0`。
- `deployments/staffAccount-v93.zip` 的 SHA-256 为 `c086ad40907d9be4341006763a28b40786df289a374a7e179c27a3892e3cf250`，ZIP 完整性和根目录版本已验证。
- 生产管理权限调用 `listTrainingMaterials` 返回 `ok=true`、空资料列表和 `canManage=true`，没有创建测试资料或写入生产业务记录。

## 网页

- 52 个本次变更的根目录网页资源已通过 CloudBase `hosting deploy --safe --verify` 发布。
- 官方回执：`totalFiles=52`、`successCount=52`、`failedCount=0`、`verified=true`。
- 托管备份前缀：`.cloudbase-backup/1791728206583/`。
- 发布后使用缓存破除 URL 逐文件获取公共 CDN 内容，52 个文件的实际字节及 SHA-256 均与本地一致。
- 培训学习从总部“管理”进入，上传上限 100 MiB，支持标题搜索、阅读和删除下架；网页登录仍仅限总部手机号密码。

## 数据库与改密码

- 迁移 `086-01-training-materials.sql` 已执行，其独立只读验收五项均为 `READY`。
- 本次生产重置在完整备份并验收后执行，执行完成时只保留两个活跃总部账号和三个活跃项目，其余业务数据清零。六个旧认证身份处于可恢复的 `BLOCKED`，私有对象没有物理删除；这是当时的验收快照，不保证后续新增数据仍为零。
- `087-readonly-verify-production-reset.sql` 三项均为 `READY`；生产标识与备份内容仅保存于私有运维记录。
- 后续只读复核发现总员工账号已为 3 个（其中总部 2 个），清理后新增了一个门店及其联系人。用户报告重新创建旧手机号失败：该号码无当前业务主档，但旧 Auth 身份仍为 `BLOCKED`；老师创建服务明确拒绝已有 Auth 身份，因此停用并不释放手机号。此次诊断未改密码、身份绑定、账号状态或业务数据；后续处理需确认目标角色与旧认证处理范围。
- 验证码修改密码、Web 总部权限、会话 UID 绑定、门店密码策略和小程序改密码专项八项通过。验证码修改密码后退出认证，不进入 Web 工作台；未实际发送短信或更改用户密码。
- 源码全仓 430 项自动化测试通过；此次发布操作没有修改正常核销、体验核销、BLE、扣次或照片流程。

## 可复用发布流程

- 已创建个人 Skill `lusizhuoer-release-upload`，覆盖云函数、网页版静态资源与小程序 COS 上传，并在 `AGENTS.md` 固化调用和验收规则。
- 小程序复用 `scripts/wechat_upload_fast.py`，上传前验证当前 COS 路由，保留原主机名的 TLS 校验，以本机 CONNECT 代理供官方上传后端使用。
- 独立 CloudBase CLI 3.8.6 的无配置代码更新分支传入 `functionPath: '.'`，打包器优先使用这个参数。因此从仓库根目录运行时可能误打整个仓库，不能只依赖 `--dir`；应先核对实际工作目录和包内容。这是已检查安装源码的版本特定行为。
- 本次独立 CLI 的 ZIP 大小报错和 COS 超时没有被计为成功；最终采用已有成功记录的官方 DevTools 通道，并完成运行时与线上文件双重验收。

## 小程序

- 开发版 `0.3.32` 已取得微信官方 CLI 最终 `✔ upload` 回执。
- 主包 `1,641,431` 字节，总包 `3,359,112` 字节；`training-materials` 分包 `21,147` 字节，`report-font` 分包 `764,244` 字节。
- 复用经过当前 COS 路由探测的官方上传通道，没有关闭 TLS 校验。
- 尚未设为体验版、提交微信审核或正式发布；这些状态与云函数、静态网页已上线分别记录。

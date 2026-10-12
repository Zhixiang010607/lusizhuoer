# 培训 PDF 阅读签名修复 v94

## 原因与范围

生产私有存储网关单对象签名返回 `signedURL`（根相对路径）及 `fullSignedURL`（完整链接）。已安装 manager-node 5.6.4 的 `signObject` 只保留 signedURL。v93 的培训读取逻辑只接受 HTTPS 绝对地址，因此上传已确认并发布的 PDF 仍可能报 TRAINING_MATERIAL_SIGN_FAILED。

v94 只在培训读取签名中兼容该根相对路径：拼接配置环境的 HTTPS 网关，再复用既有精确环境／私有桶／对象路径／token 验证，原样保留签名查询字节。任意外域、协议相对地址、其他对象、空签名均被拒绝。照片、项目 LOGO、身份认证、核销和 SQL 未修改。

## 生产部署与只读验证

- 官方微信开发者工具 CLI 部署成功：staffAccount，3 文件，68.9 KB。
- 生产 health 返回 v94；回下载 index.js、README.md、package.json 与源码逐字节一致。
- 使用只读对象引用查询和真实签名响应，经回下载代码中的 v94 校验器补全后，现有 PDF 范围读取返回 HTTP 206，文件头正确。
- 未登录的独立云函数业务调用保持 UNAUTHENTICATED。上述网关读取不是冒充手机／老师已登录的端到端验收；角色读权限另有运行时和契约回归。
- 全仓 453 项通过，包含错误地址拒绝、私有签名、老师与门店权限、PDF 队列、页面、核销及 BLE 回归。
- 无数据库写入、SQL 执行、存储桶权限修改或生产资料增删。
- `deployments/staffAccount-v94.zip` 完整性和 ZIP 根目录版本验证通过，三份文件与源码一致；SHA-256：`049ae6a9464ad59412e1b9e5e9c477125823dad0cced174578c1f144fe36a432`。

小程序 UI 随开发版 0.3.34 单独上传；静态网页版不做 UI 或托管发布，其现有 PDF 阅读会复用修复后的共享服务。

# faceRecognition v122 生产部署记录

日期：2026-10-09（Australia/Sydney）

## 安全结果

- 迁移 072 已在生产环境 `rusizhuoer-d9gbcsgym07651694` 执行。
- 6 项只读验收全部为 `READY`。
- 有效授权无次数预留：`0`。
- 正常客户余额超额预留分组：`0`。
- 老师体验额度超额预留分组：`0`。
- 授权签发前必须先原子预留次数；不足时不会生成或返回签名、令牌、授权记录和设备指令。
- 设备返回状态 `2` 后，最终工单与真实扣次仍由原有数据库函数再次原子校验；不足时整笔事务失败。

## SQL 执行

- 迁移文件：`database/cloudbase-console/072-01-ble-authorization-unit-reservation.sql`
- 迁移 RequestId：`364bb8fb-563d-46d5-b518-b31f7be9ac5a`
- 验收文件：`database/cloudbase-console/072-readonly-verify.sql`
- 验收 RequestId：`39f0c801-99f0-4b38-86ec-d6881f123dd3`

首次演练发现 SQL 使用了 PostgreSQL 保留字别名，事务因语法错误完整回滚，没有产生部分结构。别名修正后先完成整份迁移的 `ROLLBACK` 演练，再正式执行并取得上述 6 项 `READY`。

## 云函数部署

- 微信开发者工具 CloudBase CLI 返回 `success=true`。
- 上传内容：3 个文件，`88.5 KB`。
- 部署后状态：`Active`，运行时 `Nodejs18.15`，超时 900 秒。
- 运行时健康检查 RequestId：`fd389c43-2f7d-4267-83f4-f53312db5714`。
- 健康检查返回：`ok=true`、`version=v122`，照片与存储依赖均就绪。
- 生产包：`deployments/faceRecognition-v122.zip`。
- 生产包 SHA-256：`25bcfaa80b27089a214c359a5d789afd35893a632f5cab887d2d20e95e72c7cf`。

## 远端源码一致性

通过 CloudBase CLI 下载线上函数后，与仓库逐文件比较：

- `index.js`：`cfd4f9123ba8be7c3ddac7f78905baffa9b1622ad84be61d45747166f032a149`
- `README.md`：`7fa49d1ab90521bb0e235e796f03b2b816e4d9459c68ce248636cc140786a0ab`
- `package.json`：`1a3368230dc52cd9c176021248b7a79f18c7d1b962dd3ba62988fbc27a958e60`

三个 SHA-256 均与本地部署源一致。微信开发者工具自身的下载命令仍返回已知路径／二维码错误 code 17，但 CloudBase CLI 下载成功，因此本次已完成实际远端源码回验。

## 发布边界

本次只执行迁移 072 并部署 `faceRecognition v122`。没有发布静态网站，没有上传或发布新的小程序版本，也没有修改设备固件。

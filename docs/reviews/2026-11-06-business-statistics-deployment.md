# 2026-11-06 统计一致性与客户记录分页部署

源代码提交：`43d9b96b27336cbfbd249bac5ac1be1daecc1e3f`。环境与小程序 AppID 均按项目配置复核。沿用原平台资源，不重建云函数，不改系统代理、证书或 hosts。

## 数据库

用户已确认按历史有效业务划分客户业务阶段，并授权部署。先重新只读预览，再通过 `scripts/cloudbase-pg-change.js` 完整备份 **43张public基础表、406行、46个序列值**，行数差异为0，随后在同一备份门禁执行092。

- [092-preview.sql](../../database/cloudbase-console/092-preview.sql)：已执行只读预览，预计阶段变化0个。
- [092-01-historical-customer-business-stage.sql](../../database/cloudbase-console/092-01-historical-customer-business-stage.sql)：已通过完整备份门禁执行。
- [092-readonly-verify.sql](../../database/cloudbase-console/092-readonly-verify.sql)：已独立执行，两项READY。

逐表双向 EXCEPT ALL 比较43表；customers仅排除允许修改的 customer_process_status，其余字段和所有其他表差异均为0。函数只改变 refresh_customer_balance，其他函数、原权限、列、约束、触发器及序列保持；新函数执行体与092源码核对一致。备份schema及含生产数据的回执只在私有目录保存，尚未清理。

迁移后再次以同一SQL快照核对：全局、门店、老师（含未指定老师）及项目四项合计相等。账本、客户缓存、余额、时间、重复编号、引用、次数及阶段检查全部通过。未创建生产测试工单、客户、照片或审核记录。

## 云函数

仅部署 **faceRecognition v141**。官方开发者工具明确指定函数目录，报告7个文件、部署成功；线上health返回v141，考勤照片运行时自检ready。再次经官方工具下载部署代码，7个根文件与本地逐字节一致。

[faceRecognition-v141.zip](../../deployments/faceRecognition-v141.zip) 已验证：113446字节；SHA-256 `9f790677321f9de2e3a539e4e96608a995c3024801e3478aac96bdb6cfb1e7a6`。运行时、package、README和文件名一致；[校验记录](../../deployments/faceRecognition-v141-verification.json)。staffAccount、customerRating、verificationPhoto与teacherCreate本轮不重复部署。

## 网页

仅从限定目录发布7份资源：app.js、index.html、customer-detail.html、customer-profile.js、hq-dashboard-report.js、styles.css、web-tablet-parity.css。CloudBase CLI 3.8.7 使用空根路径（不传 `/`）、`--safe --verify`、不使用prune；入口文件最后上传。发布前安全备份已保留，平台报告7成功、0失败、verified=true；随后带缓存隔离参数公开下载7份文件，SHA-256全部与源码一致。无失败重试或回滚。

仅进程局部使用既有回环CONNECT代理，原目标主机名及端到端TLS校验保持。未上传仓库根目录、私有操作文件、其他客户端或生产数据。

## 小程序

开发版 **0.3.58** 已取得官方最终 `✔ upload`，后台同时确认 `progressSuccess`，耗时268732 ms。主包 **1711476字节**，总包 **3522574字节**，各实际分包小于2 MiB。复用已登录的健康IDE，未重启、未重试；上传前已按发布技能执行COS线路TLS检查。

上传前后429份工程文件逐字节一致，用户 project.config.json、排除打包的 services/Untitled.png 和未保存编辑保留。新增发布说明在源文件一致性验收后写入，不属于上传产物。原始上传、后台成功、大小和源码哈希回执均只在私有目录保存。此结果仅证明开发版上传，不表示已选择体验版、提审或正式发布；详见[0.3.58记录](../../miniprogram-app/releases/0.3.58.md)。

## 回归与交付边界

704项全仓回归及158项隔离数据库检查通过；114项组长SQL、产品查询和核销恢复隔离测试通过。手机320／390／430、iPad768／834／1024竖屏与1024×768横屏、Web1024／1280／1440／1920界面验收见[审计报告及效果图](2026-11-06-business-statistics-consistency.md)。这些是开发者工具及浏览器隔离验收，不冒充物理真机业务实测。

正式微信审核／发布未在本轮执行。源代码推送、云函数部署、SQL、Web及小程序上传分别验收，不互相替代。

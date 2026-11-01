# 总部排名链接与培训 PDF 发布恢复

日期：2026-11-01。状态：源码验收；**不代表云函数或小程序已部署，不代表 8MB 真机上传已达到秒级**。

后续发布：用户要求发布后，staffAccount v97 已部署并完成运行时／源码回读，小程序开发版 0.3.50 已取得官方成功回执；见[独立发布记录](2026-11-01-staff-v97-mini-0350-release.md)。下文“尚未上传”描述源码验收时点，不是当前发布状态。

## 排名与权限

- 小程序总部完整排名删除重复“序号”，保留服务端实际名次、每页十条及原翻页／跳页。第二页从第 11 名继续，导出与统计不变。
- 门店／老师名称使用暖棕色、下划线及原单元格居中规则，进入现有对应主页。使用服务端主档编号作路由引用，避免老师主档数字 ID 与员工账号 ID 碰撞；不在界面显示该编号。
- 只有总部块显示这些链接，操作再检查总部角色、当前维度、当前页实际记录及加载／错误状态。未指定老师、缺失真实主档编号均为普通文本。
- 老师与门店端没有其他老师、门店或总部主页的名称链接，只保留原服务端授权范围的客户主页链接；工单编号查看详情不变。
- 实际 UID 派生身份、老师本人查询、门店锁定本店及总部详情路由的权限回归通过，未改服务端权限实现。

## 培训问题：已证明与未证明

旧实现的两个缺陷先由运行测试复现：

1. INSERT 已提交但 RETURNING 为空时返回 `id: "undefined"`，没有有效发布状态。
2. 写入回执或后续回读不确定时删除已经上传完整的 PDF，破坏原请求恢复。

线上只读日志在本轮查到三次 `confirmTrainingMaterialUpload` 返回 `TRAINING_MATERIAL_UPLOAD_INCOMPLETE`，另有存储对象不存在记录。这只能证明那些确认时点还没有可读完整对象，不能把所有三四分钟等待都归咎数据库，也不能认定用户那次文件一定已上传成功。没有读取或上传真实资料内容。

既有[隔离网络对照](2026-10-16-training-pdf-transport-benchmark.md)已经显示 PG／COS 通道在该 Mac 上可能出现大文件传输慢和中止，本轮未无界重复这些已失败实验，未新增收费加速、公开桶、网关代理或生产测试对象。

## 修复后的流程

- 正常链路仍为申请签名 → 一次二进制 PUT → 原请求确认发布；权限、私有桶、PDF 100 MiB、真实长度／类型／文件头、删除防重保留。
- `staffAccount v97` 在 INSERT 异常或空返回时按原请求独立回读；只有异常才多一次读取。尚不能确认的写入返回 `TRAINING_MATERIAL_PUBLISH_PENDING`，保留完整对象而不删除。
- 小程序只接受真实正整数资料 ID 与 `PUBLISHED`。完整 PUT 回执保存在原任务中；之后的暂时 missing、存储读取或数据库确认故障只重试发布，不再丢引用并重传。冷启动仍先恢复原结果，本地文件丢失也不阻止确认。
- 任意大小收到 2xx 响应头后可以触发一次服务端确认，与小文件已有八秒确认共用同一个请求；响应头自身不是成功证明。不循环探测大文件、不并发重传，不缩短原 180 秒上限。微信模拟器可能不提供响应头 statusCode，此时保持原完整回调路径。
- 资料成功后继续立即显示并后台刷新列表。可选私有缓存复制移出上传队列关键路径，源文件保留到其缓存复制结束，下一个文件不必等待。
- 待处理区区分“重试发布”和“立即重试”。可能有发布在途的任务，取消、移除或过期不能自动删除其对象；已有绑定／可能已发布资料仍保留，后续有需要须按精确引用另行核对清理。
- 不修改照片链路。打卡／现场人脸照片由云函数接收，工单补充照片才是另一种签名直传；不能把这些入口混为一谈，也不能把 PDF 伪装成照片上传。
- Web 请求与成功响应格式不变，无新 action 或必填字段；本轮不更改 Web 客户端。旧 Web 的确认失败清理行为没有改造成小程序的持久任务恢复，不宣称网页版恢复能力已同步升级。

## 验证

- 全仓 `node --test tests/*.test.js`：**644 通过、0 失败**。
- 排名／权限／培训发布、队列、页面、阅读、签名、Range 专项：115 通过。
- 295 个已跟踪或本轮新增 JavaScript 语法检查通过，`git diff --check` 通过。
- 原生隔离预览使用生产 UI 的 56 个文件，逐字节及 SHA-256 核对零差异；只有 API、会话及上传任务为合成数据，无生产认证绕过、业务请求或真实文件传输。
- 320／390／430 手机、768×1024／834×1112／1024×1366 iPad 竖屏、1024×768 横屏均检查排名及恢复操作，滚动到真实页尾；总部老师／门店链接实际打开对应既有详情路由。空排名／读取失败也检查。分页第二页实际为 11—20 名。
- 开发者工具 3.17.1 灰度基础库在部分点击出现内部 `clickCheckTask`／渲染层诊断（堆栈在平台脚本中），另外有既有组件选择器及预加载警告。目标页面均实际加载，但不能据此宣称模拟器控制台全零错误，真机验收仍需单独完成。

效果证据：

- [320 手机排名](assets/2026-11-01-pdf-publication/phone-320-ranking-final.png)、[390 手机老师排名](assets/2026-11-01-ranking-links/phone-390-teacher-ranking.png)、[430 手机排名](assets/2026-11-01-pdf-publication/phone-430-ranking.png)
- [768 排名](assets/2026-11-01-pdf-publication/ipad-768-ranking.png)、[834 排名](assets/2026-11-01-pdf-publication/ipad-834-ranking.png)、[1024 竖屏排名](assets/2026-11-01-pdf-publication/ipad-1024-portrait-ranking-complete.png)、[横屏页尾](assets/2026-11-01-pdf-publication/ipad-1024-landscape-ranking.png)
- [320 恢复操作](assets/2026-11-01-pdf-publication/phone-320-recovery-complete.png)、[390 恢复操作](assets/2026-11-01-pdf-publication/phone-390-recovery.png)、[430 恢复操作](assets/2026-11-01-pdf-publication/phone-430-recovery.png)
- [768 恢复操作](assets/2026-11-01-pdf-publication/ipad-768-recovery.png)、[834 恢复操作](assets/2026-11-01-pdf-publication/ipad-834-recovery.png)、[1024 竖屏恢复](assets/2026-11-01-pdf-publication/ipad-1024-portrait-recovery.png)、[横屏恢复](assets/2026-11-01-pdf-publication/ipad-1024-landscape-recovery.png)

## 部署与残余问题

- 新包：`deployments/staffAccount-v97.zip`，72,145 字节，根目录仅 index.js／package.json／README.md；三文件与源码字节一致，运行版本、README 和包版本为 v97／97.0.0。
- ZIP SHA-256：`89cf9c24d1c529849133e2d469612622559f93c5424a82030ad388d0497336c0`。
- 本轮只读 health 仍为生产 **v96**；**v97 尚未上传**。新小程序也未上传，已成功的开发版仍为 0.3.49；未更换体验版、提交审核或正式发布。
- 没有 SQL、生产业务数据写入、资料／照片增删、静态网站发布或其他云函数实现变更。跨函数 README 仅更新联动说明。
- **8MB 在用户手机的传输吞吐瓶颈仍未解决或验收达标**。已修复的是可复现的确认／恢复缺陷和无用等待，不把模拟八秒恢复等同真机传输时间。下一步需要在更新后同手机、同网络分开取得准备、签名、传输及确认时间；若原 PUT 仍需数分钟，应据真实传输记录决定另一个受支持的存储通道，而不是继续重复整文件或放宽权限。

参考：[CloudBase PG 模式架构](https://docs.cloudbase.net/storage/pg/introduce)、[签名上传协议](https://docs.cloudbase.net/en/http-api/storage-pg/%E9%80%9A%E8%BF%87%E9%A2%84%E7%AD%BE%E5%90%8D%E4%B8%8A%E4%BC%A0%E9%93%BE%E6%8E%A5%E4%B8%8A%E4%BC%A0%E5%AF%B9%E8%B1%A1)、[微信官方 RequestTask 类型](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)。

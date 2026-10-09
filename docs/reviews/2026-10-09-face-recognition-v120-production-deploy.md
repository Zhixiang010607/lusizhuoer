# faceRecognition v120 生产部署记录

日期：2026-10-09（Australia/Sydney）

## 目标

在同一张仍有效的 90 秒人脸资格内，重复扫描同一二维码和同一台待机设备时，允许根据本轮实时 nonce 生成新授权；旧 token 立即失效。设备、二维码、类型或次数任一变化都拒绝，设备已经进入工作态时只恢复原工单。

## 部署结果

- 环境：`rusizhuoer-d9gbcsgym07651694`
- 函数：`faceRecognition`
- 目标版本：`v120`
- 官方 CloudBase CLI 完整上传回执：`success=true`
- 文件数量：3
- 上传包体：`87.4 KB`
- 上传文件：`index.js`、`package.json`、`README.md`

完整上传前曾发生一次环境列表瞬时 `ret=-3 system error`；重试后先完成源码和 README 增量上传，最终三文件完整上传成功。不能把前一次瞬时错误当作最终部署失败，也不能用增量成功替代最终完整回执。

## 交付包校验

- ZIP：`deployments/faceRecognition-v120.zip`
- ZIP 根目录：仅 `index.js`、`package.json`、`README.md`
- ZIP SHA-256：`364bf27d2c4b0ae5524b0cd49e46299b2e7d8ad7d0d8c497926a111040a38b0c`
- ZIP 内 README 可见当前版本：`v120`
- ZIP 内运行时代码声明：`FUNCTION_VERSION = "v120"`
- 源码 `index.js` SHA-256：`97bd8d7a3bb3679e3da492978491bf27544180d403616e403695803ee20624a7`

## 验证边界

- 全量本地回归通过；最终加入小程序自适应 MTU 后为 355/355。
- 本次没有新增 SQL；迁移 071 仍是允许跨资格重复 nonce 的生产前置条件，已在此前执行。
- 本次没有通过已登录业务账号独立调用运行时 `health`，因此不得把上传成功表述为运行时健康检查已通过。
- 云函数上传、小程序开发版上传、体验版、审核版和正式版是相互独立的状态。

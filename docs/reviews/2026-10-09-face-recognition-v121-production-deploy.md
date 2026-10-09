# faceRecognition v121 生产部署记录

日期：2026-10-09（Australia/Sydney）

## 结果

- 微信开发者工具 CloudBase CLI 返回 `success=true`。
- 上传内容：3 个文件，`87.6 KB`。
- 部署后函数状态：`Active`，运行时 `Nodejs18.15`，超时 900 秒。
- 生产包：`deployments/faceRecognition-v121.zip`。

## 一致性

- ZIP SHA-256：`012327674521986b3813f90a887527e4346660b715e2b42f5b1c05471b60fb0f`
- ZIP 根目录 `index.js` SHA-256：`b3584703463c99117288e34886660fb71289eeb57dca3c7d972267709ea9c036`
- ZIP 根目录 `README.md` SHA-256：`b9274d035ae031354ac46ff22ad9be47f03d38b5a4dec0666b705ac90238e50c`
- ZIP 根目录仅包含 `index.js`、`package.json`、`README.md`，README 与运行时代码均报告 `v121`。

## 本版修复

同设备有效期内重签时，以旧 `authorization_token` 作为数据库原子比较条件；并发请求只有一个可以更新成功。首次授权插入遇到资格唯一键竞争时直接返回 `BLE_AUTHORIZATION_RACE`，不再递归重进签发逻辑，因此不会由一个用户动作签出两个 token。

## 验证边界

尝试从线上下载源码做二次哈希回验时，开发者工具返回路径错误 code 17，因此没有取得远端下载副本；本记录不把 `Active` 状态和上传成功表述成远端源码哈希已回验。没有通过业务账号独立调用运行时 `health`。本次不需要 SQL，也没有静态网站部署。

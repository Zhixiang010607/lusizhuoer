# faceRecognition v118 生产部署记录

日期：2026-10-08（Australia/Sydney）

## 原因

设备端真机记录中的授权签名仍为 `52774bfa...`。该值来自生产 `faceRecognition v117` 的旧固定生产 Key 协议；当时仓库虽已完成 v118 凯撒签名代码与交付包，但云函数尚未覆盖生产。

## 部署

- 环境：`rusizhuoer-d9gbcsgym07651694`
- 函数：`faceRecognition`
- 目标版本：`v118`
- 官方 CloudBase CLI 回执：`success=true`
- 文件数量：3
- 上传包体：`86.2 KB`
- 部署后状态：`Active`

## 线上源码回验

部署后重新下载线上完整函数，以下文件 SHA-256 与仓库完全一致：

- `index.js`：`7cfdc92473133df6a140eef134d2dd40e2375ac2194b443c9d239a7ea71bff96`
- `package.json`：`1a3368230dc52cd9c176021248b7a79f18c7d1b962dd3ba62988fbc27a958e60`
- `README.md`：`1083d6c5e784ed2a73463d215f0111890c20ed1b2902d7102f18baf1f2537947`

远端 `index.js` 声明 `FUNCTION_VERSION = "v118"`，并以 `verificationBleSignature(nonce)` 生成 `auth.signature`；没有读取 `BLE_AUTH_SIGNING_KEY`。

固定验收向量：

```text
nonce     = 00112233445566778899aabbccddeeff
signature = 41638537597196183052aecgeigdifkh
```

## 边界

迁移 071 已在此前生产执行，4 项只读检查均为 `READY`。本次没有新增 SQL，没有修改其他云函数，也没有重新上传小程序。函数部署与源码回验成功，但本次未通过已登录业务账号独立调用运行时 `health`；真机下一次重新办理资格并扫码时应直接核对新 `auth.signature`。

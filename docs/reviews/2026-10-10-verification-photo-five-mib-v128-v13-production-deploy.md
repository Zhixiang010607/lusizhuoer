# 核销补充照片 5 MiB 生产部署记录

日期：2026-10-10  
环境：`rusizhuoer-d9gbcsgym07651694`

## 完成内容

- 生产执行迁移 083，将核销完成后的三个 `EXTRA` 补充照片位及直传任务单张硬上限提升到 `5242880` 字节。
- 六项只读验收全部返回 `READY`；`FACE` 现场人脸证据仍为 `3145728` 字节。
- 线上 `customer-photos` 核对为 `public=false`、`file_size_limit=7000000`、仅允许 `image/jpeg`。现有配置已经满足要求，因此没有修改桶容量、公开状态或客户端策略。
- 通过官方 CloudBase CLI 部署 `faceRecognition v128` 和 `verificationPhoto v13`，两者状态均为 `Active`。
- 部署后重新下载线上函数；`faceRecognition` 三个根文件、`verificationPhoto` 五个根文件与本地部署源逐文件 SHA-256 一致。
- 控制台函数测试编辑器显示“加载失败”，未取得独立运行时 `health` 结果；本记录不把 Active 与源码一致性表述为 health 已通过。
- 通过微信官方 CLI 上传小程序开发版 `0.3.21`，回执为 `✔ upload`；主包 `1818689` 字节，总包 `3518723` 字节。

## 回归结果

- 照片专项：46 项通过。
- 全仓：387 项连续三轮通过。
- 已跟踪小程序 JavaScript：语法检查通过。

## 交付包

- `deployments/faceRecognition-v128.zip`：SHA-256 `921e8e2d714064c48108bef8ee68933e67c4a8a99704f9c4e7d1ab71dfd99c32`
- `deployments/verificationPhoto-v13.zip`：SHA-256 `8978290c9c450e9525791f8a535969f9b8d19188af5219809fb67b8c1567f13a`

## 未执行

- 未把 `0.3.21` 设为体验版。
- 未提交微信审核。
- 未正式发布。

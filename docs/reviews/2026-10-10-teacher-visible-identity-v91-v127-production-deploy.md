# 老师可见身份生产部署记录

日期：2026-10-10（Australia/Sydney）

## 根因与数据核对

- 生产只读核对确认老师 5 条、空编号 0 条、唯一编号 5 个、重复编号 0 组；客户 3 条、空编号 0 条、唯一编号 3 个、重复编号 0 组。
- 多个老师显示为 `T200` 的根因是旧 `listStaff` 用 `LPAD(account.id::text, 3, '0')` 生成展示短编号；PostgreSQL 会把超过三位的文本截断。真实 `teacher_code` 没有重复。
- 本轮没有数据库结构或数据写入，不需要执行 SQL。老师与客户真实编号、主键和唯一约束保持不变。

## 云函数

- `staffAccount v91` 已完整部署：官方 CLI 回执 `success=true`、3 个文件、`64.1 KB`；状态 `Active`，运行时 Node.js 20.19，超时 90 秒。
- `faceRecognition v127` 已完整部署：官方 CLI 回执 `success=true`、3 个文件、`94.9 KB`；状态 `Active`，运行时 Node.js 18.15，超时 900 秒。
- 下载两套生产副本后，三个核心文件与仓库逐文件一致：
  - `staffAccount/index.js`：`2c2fd987ce22cdacc562babcbea902d4e3cc63f9c131061827e8ff99d1dde42a`
  - `staffAccount/package.json`：`023a694454e96f44eb2d7d3ad42736654362ee9704583c6fbedb135669bdc1c3`
  - `staffAccount/README.md`：`192c2cf4841e559e8d081d7256f1be06c924ae9374502be393fcb3a4c05bea6c`
  - `faceRecognition/index.js`：`ff573fef143a99b6c12da87aba458f4465eaa3aac3082067708f6fee97a18ce5`
  - `faceRecognition/package.json`：`09a13cfd255d09f5db0225d7e29aa37dc404529576540fe3673f7a25ae2c42ca`
  - `faceRecognition/README.md`：`818e58f823cc75c5cbe434c51ddfcc144dca1d7f1dfc1712d5535d1073cca8a7`
- 交付包 `staffAccount-v91.zip` SHA-256：`b8e9d108b2c02b80c5ff5e1ce3e9e3082137c2c7e94046179cf9b2dbba392f40`。
- 交付包 `faceRecognition-v127.zip` SHA-256：`b8e4730b0d5fd1a693f8535afeec45125970b5f9e80146c9ff6196a5c82f678d`。

## 小程序与业务边界

- 小程序开发版 `0.3.17` 已上传成功：主包 `1,808,395` 字节，总包 `3,504,536` 字节。
- 小程序老师目录、老师主页和业务老师选择只显示姓名与唯一登录手机号；服务端仍用真实 `teacherId`／`teacher_code` 做权限、关联和审计。
- 全仓 379 项测试通过。
- 正常／体验／补录核销、照片、BLE、设备授权、客户余额和最终原子扣次规则均未修改。
- 小程序尚未设为体验版、提交审核或正式发布。

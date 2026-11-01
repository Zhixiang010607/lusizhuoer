# staffAccount v97 与小程序开发版 0.3.50 发布记录

日期：2026-11-01，Australia/Sydney；13:07 AEDT 完成核验。

## 发布范围

- 用户在源码验收后明确要求“发布”。发布源码为 `f22cf6b9cc63ff8d12f87614e68cb50fb87d222f`。
- 仅更新生产环境 `rusizhuoer-d9gbcsgym07651694` 的 `staffAccount`，以及 AppID `wxb053c1bd6c684d8b` 的小程序开发版。没有静态 Web、其他云函数实现或数据库变更。
- 包含总部排名去重复序号、总部名称主页链接与老师／门店链接隔离，以及培训 PDF 发布确认和原任务恢复修复；详细范围及限制见[源码验收](2026-11-01-ranking-and-training-publication.md)。

## 云函数：已部署并核验

- 按发布技能使用官方 DevTools CLI，明确指定 `cloudfunctions/staffAccount`，没有从仓库根目录打包。
- 官方回执：`success=true`、`filesCount=3`、`packSize=71.0 KB`。
- 独立运行时 `health` 返回 `ok=true`、`version=v97`、`managerNodeInstalled=true`。
- 独立下载线上代码，三文件与发布源码逐字节一致：

| 文件 | 线上与本地一致的 SHA-256 |
| --- | --- |
| index.js | `11d504673838956106a73d3527a8198f39d18b6147fd7c0e669bb8f098bce44a` |
| package.json | `338740dae5def89c950abb2b8f35267f174d1d31af1cfd8e8eeb3819ba02789a` |
| README.md | `ac3b928635b13e38c6e8b10a48d9202ba82d5f39b0a5506eaa99cb5e804d02c5` |

- `deployments/staffAccount-v97.zip`：72,145 字节，完整性通过，根目录仅上述三文件，均与源码字节一致；运行时、README、包版本为 v97／97.0.0。
- ZIP SHA-256：`89cf9c24d1c529849133e2d469612622559f93c5424a82030ad388d0497336c0`。

## 小程序：开发版已上传

- 上传前 `scripts/wechat_upload_fast.py check` 当前 COS 线路验证 TLS 成功；随后仅串行执行一次官方上传，不关闭 TLS 验证、不改系统代理或 hosts。
- 官方 CLI 最终回执为 **`✔ upload`**，开发版 **0.3.50**。
- 主包 **1,687,735 字节**，总包 **3,439,627 字节**。
- 使用正式项目目录；隔离 QA 工程未上传。用户 `project.config.json` 私有编辑及未跟踪图片均保留；`services/Untitled.png` 继续由打包排除项排除。
- 这是开发版上传，不代表已设体验版、提交审核或正式发布；本轮没有执行这些后续阶段。

## 验证与安全边界

- 发布前全仓 `node --test tests/*.test.js`：**644 通过，0 失败**；`git diff --check` 通过。
- 本轮没有生产 SQL、账号／资料／照片增删、真实 PDF 测试上传或业务写入，没有更改核销、人脸、BLE、扣次和审核规则。
- 原始官方回执、健康响应、下载代码和测试日志保存在 `.codex-private/release-v97-mini0350-20261101/`，未将凭据、签名或生产数据提交到 Git。
- **8MB 文件在用户真机的传输速度仍未实测达标。** 当前发布修复确认失败、重复传输和可选缓存等待，不把本次开发包上传成功解释为培训 PDF 已实现秒传。
- 按发布技能保存版本与回执，先核验后端再上传客户端；本记录单独提交并推送，不夹带用户未保存编辑或无关文件。

# 088 考勤照片

仅新增考勤照片字段和新打卡照片保护；历史记录不补照片，不改变核销、余额或 BLE。

执行顺序：

1. 只读确认目标环境为 `rusizhuoer-d9gbcsgym07651694`，检查既有 078／081 和照片私有桶。
2. 依次执行 `088-01-teacher-attendance-photo-schema.sql`、`088-02-teacher-attendance-photo-guard.sql`，每一份都必须通过 `scripts/cloudbase-pg-change.js --env rusizhuoer-d9gbcsgym07651694 --label attendance-photo-v88 --sql <该文件路径> --apply` 完整备份、验收后执行，不得绕过备份门禁。不要把两份拼接后粘贴进有长度限制的控制台。
3. 单独运行 `088-readonly-verify.sql`，四项必须 READY。
4. 部署 `faceRecognition-v130.zip`，由平台安装 Linux Node.js 20 的 sharp 及其 optional dependencies；不得上传 Mac node_modules。核对 health 与线上代码后才更新客户端。

2026-10-15 两份 SQL 已分别通过完整备份门禁在生产执行；40 张 public 表逐表行数一致，四项只读验收均 READY。备份 schema 与私有回执保留。v129 部署回读发现旧 Nodejs18.15 低于 sharp 原生包最低要求，当前应部署 v130 并使用 Nodejs20.19，运行合成压缩探针验收；不要再次上传 v129。各客户端和正式发布状态以当日发布记录为准。

须安排 SQL、云函数和小程序客户端协调升级；旧客户端没有明确留存同意标记，升级后的服务端将拒绝新打卡并提示更新，不会静默保存。已完成打卡的幂等回读仍保留。图片右下角为“上班打卡／下班打卡”和服务端北京时间，和该笔记录同一时刻；不写位置。上线前须同步实际隐私保护指引中的打卡照片留存用途。

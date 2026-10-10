# 迁移 083：补充照片 5 MB 上限

按顺序在原 CloudBase PostgreSQL 环境中整文件执行：

1. `083-01-verification-extra-photo-five-mb.sql`
2. `083-readonly-verify.sql`

第二个文件应返回六行 `READY`，其中第六行只读确认既有 `customer-photos` 继续为
私有 JPEG 桶且单文件上限不少于 `5242880` 字节；本迁移不会修改桶容量、公开状态
或客户端策略。随后部署 `faceRecognition v128` 与
`verificationPhoto v13`，分别调用 `health` 核对公开版本；照片服务还应返回
`sharedVersion=v12`，并确认私有照片桶单文件上限不少于 `5242880` 字节。

本迁移只把核销工单三个补充照片位及其直传任务从 3 MiB 提升到 5 MiB。客户建档照、
核销现场人脸、老师考勤人脸、缩略图、24 小时编辑窗口、每单一个上传任务、权限和
SHA-256／尺寸校验均不改变。旧客户端继续上传不超过 3 MiB 的照片，保持兼容。

生产环境 `rusizhuoer-d9gbcsgym07651694` 已于 2026-10-10 完整执行第 1 步，随后用
当前第 2 步取得六行 `READY`。线上 `customer-photos` 当时为 `public=false`、
`file_size_limit=7000000`、`allowed_mime_types={image/jpeg}`，已满足要求，因此没有
修改桶容量或公开状态。

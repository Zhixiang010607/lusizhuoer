# 079 恢复补录核销待审流程

1. 完整执行 `079-01-supplement-verification-review.sql`；该文件已经包含全部迁移内容，可直接整份复制到 CloudBase SQL 编辑器。
2. 执行 `079-readonly-verify.sql`，六行结果必须全部为 `READY`。
3. 再部署 `faceRecognition v125`、`staffAccount v87`，最后上传配套小程序。

补录由门店或老师提交，老师账号固定绑定本人；门店可不指定老师。提交时不做人脸、不保存现场照片、不签发 BLE 授权，也不会生成设备开启信号。工单先进入 `PENDING`，只有总部审核通过时才由数据库再次锁定客户并原子校验、扣减余额；余额不足时审批失败且不会扣成负数。

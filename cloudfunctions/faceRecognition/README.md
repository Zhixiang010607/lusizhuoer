# faceRecognition 云函数

该函数只在 CloudBase 后端运行，使用腾讯云“人脸识别”的人员库和人脸搜索接口；客户无需提供身份证。

## 必需环境变量

在 CloudBase 的 `faceRecognition` 函数配置中设置：

- `FACE_SECRET_ID`
- `FACE_SECRET_KEY`
- `FACE_GROUP_ID=lusizhuoerdatabase`

请勿把任何密钥写入此目录、网页 JavaScript、README 或 GitHub。

## 部署

将本目录作为函数代码目录部署。部署端会执行 `npm install` 以安装 `tencentcloud-sdk-nodejs`。函数入口为 `index.main`。

## 调用格式

```json
{ "action": "registerCustomer", "customerId": "C001", "imageBase64": "..." }
```

```json
{ "action": "searchCustomer", "imageBase64": "..." }
```

`imageBase64` 仅接受从摄像头即时采集的图片。正式上线前仍需补充活体检测、客户明确授权、删除机制和业务鉴权；人脸搜索结果不能单独作为扣次依据。

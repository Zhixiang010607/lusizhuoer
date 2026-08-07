"use strict";

/**
 * 客户人脸库服务。
 *
 * 环境变量（仅在 CloudBase 控制台配置，绝不可写入前端或 Git）：
 * FACE_SECRET_ID、FACE_SECRET_KEY、FACE_GROUP_ID
 *
 * event.action:
 *   health              检查部署配置
 *   registerCustomer    首次建档：{ customerId, imageBase64 }
 *   searchCustomer      核销识别：{ imageBase64 }
 */
const tencentcloud = require("tencentcloud-sdk-nodejs");
const IaiClient = tencentcloud.iai.v20180301.Client;

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少云函数环境变量：${name}`);
  return value;
};

function client() {
  return new IaiClient({
    credential: {
      secretId: required("FACE_SECRET_ID"),
      secretKey: required("FACE_SECRET_KEY")
    },
    region: "ap-guangzhou",
    profile: { httpProfile: { endpoint: "iai.tencentcloudapi.com" } }
  });
}

function cleanBase64(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("请提供摄像头采集的人脸图像。");
  return value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
}

exports.main = async (event = {}) => {
  const action = event.action || "health";
  const groupId = required("FACE_GROUP_ID");

  if (action === "health") {
    return { ok: true, groupId, message: "人脸识别云函数已就绪" };
  }

  const image = cleanBase64(event.imageBase64);
  const api = client();

  if (action === "registerCustomer") {
    const personId = String(event.customerId || "").trim();
    if (!personId) throw new Error("首次建档必须提供客户编号。");
    const result = await api.CreatePerson({ PersonId: personId, GroupId: groupId, Image: image, PersonName: personId });
    return { ok: true, action, personId, faceId: result.FaceId };
  }

  if (action === "searchCustomer") {
    const result = await api.SearchFaces({ Image: image, GroupIds: [groupId], MaxFaceNum: 1, FaceMatchThreshold: 80 });
    const candidate = result.Results?.[0]?.Candidates?.[0];
    if (!candidate) return { ok: true, matched: false, message: "未识别到已建档客户" };
    return { ok: true, matched: true, customerId: candidate.PersonId, score: candidate.Score };
  }

  throw new Error(`不支持的操作：${action}`);
};

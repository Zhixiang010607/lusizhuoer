const config = require("../config/env");
const { getApp } = require("./cloudbase");

function parsed(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function resultData(raw) {
  return [raw && raw.result, raw && raw.data && raw.data.result, raw && raw.data, raw]
    .map(parsed)
    .find((value) => value && typeof value === "object" && (
      Object.prototype.hasOwnProperty.call(value, "ok") ||
      Object.prototype.hasOwnProperty.call(value, "code") ||
      Object.prototype.hasOwnProperty.call(value, "message")
    )) || {};
}

function businessError(payload, fallback) {
  const error = new Error(payload.message || fallback);
  error.code = payload.code || "BUSINESS_REQUEST_FAILED";
  error.requestId = payload.requestId || "";
  for (const field of ["stage", "storeId", "storeCode", "storeRolledBack", "transportUncertain", "completed"]) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) error[field] = payload[field];
  }
  return error;
}

async function call(name, data, fallback) {
  let raw;
  try {
    raw = await getApp().callFunction({ name, data });
  } catch (cause) {
    const error = new Error(cause && cause.message ? cause.message : fallback);
    error.code = cause && cause.code ? cause.code : "FUNCTION_INVOCATION_FAILED";
    error.requestId = cause && (cause.requestId || cause.RequestId) || "";
    error.submissionUncertain = true;
    throw error;
  }
  const payload = resultData(raw);
  if (!payload.ok) throw businessError(payload, fallback);
  return payload;
}

function callFace(action, data = {}) {
  return call(config.faceFunction, { action, ...data }, "业务服务没有返回有效结果");
}

function callPhoto(action, data = {}) {
  return call(config.photoFunction, { action, ...data }, "核销照片服务没有返回有效结果");
}

function callStaff(action, data = {}) {
  return call(config.staffFunction, { action, ...data }, "员工账号服务没有返回有效结果");
}

function callRating(action, data = {}) {
  return getApp().callFunction({ name: config.ratingFunction, data: { action, ...data } })
    .then((raw) => {
      const payload = [raw && raw.result, raw && raw.data && raw.data.result, raw && raw.data, raw]
        .map(parsed)
        .find((value) => value && typeof value === "object"
          && Object.prototype.hasOwnProperty.call(value, "success"));
      if (!payload || payload.success !== true) {
        const error = new Error(payload?.error?.message || "客户评价服务没有返回有效结果");
        error.code = payload?.error?.code || "RATING_SERVICE_FAILED";
        throw error;
      }
      return payload.data || {};
    })
    .catch((cause) => {
      if (cause?.code === "RATING_SERVICE_FAILED" || cause?.code && cause?.message) throw cause;
      const error = new Error(cause?.message || "客户评价服务没有返回有效结果");
      error.code = cause?.code || "FUNCTION_INVOCATION_FAILED";
      error.requestId = cause?.requestId || cause?.RequestId || "";
      throw error;
    });
}

function callTeacherCreate(data = {}) {
  return call(config.teacherCreateFunction, { action: "createTeacher", ...data }, "老师账号创建服务没有返回有效结果");
}

module.exports = { callFace, callPhoto, callStaff, callRating, callTeacherCreate, resultData };

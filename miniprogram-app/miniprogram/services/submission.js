const { callFace } = require("./api");
const { readSession } = require("./session");

const PREFIX = "lusizhuoerMiniSubmissionV1:";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}
function key(recordType) {
  const session = readSession();
  if (!session) throw new Error("登录状态已经失效");
  return `${PREFIX}${session.uid}:${String(recordType).toUpperCase()}`;
}
function randomId(recordType) {
  return `mp_${String(recordType).toLowerCase()}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`.slice(0, 64);
}
function read(recordType) {
  const value = wx.getStorageSync(key(recordType));
  return value && typeof value === "object" ? value : null;
}
function begin(recordType, payload) {
  const type = String(recordType).toUpperCase();
  const fingerprint = hash(stable(payload));
  const existing = read(type);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error("上一次提交结果尚未确认，禁止用新资料重复提交。请先检查上次提交结果");
    return existing;
  }
  const intent = { recordType: type, clientRequestId: randomId(type), fingerprint, storeId: String(payload.storeId || ""), state: "SUBMITTING", createdAt: Date.now() };
  wx.setStorageSync(key(type), intent);
  const saved = read(type);
  if (!saved || saved.clientRequestId !== intent.clientRequestId) throw new Error("无法保存防重复提交编号，已禁止提交");
  return saved;
}
function markUncertain(recordType) {
  const intent = read(recordType);
  if (!intent) return;
  wx.setStorageSync(key(recordType), { ...intent, state: "UNCERTAIN", updatedAt: Date.now() });
}
function clear(recordType) {
  wx.removeStorageSync(key(recordType));
  if (read(recordType)) throw new Error("无法清除防重提交锁，已禁止继续办理");
  return true;
}
function confirm(recordType, recordId) {
  const intent = read(recordType);
  const id = String(recordId || "");
  if (!intent || !intent.clientRequestId || !id) throw new Error("无法确认已写入工单，已保持防重复提交锁");
  const confirmed = { ...intent, state: "CONFIRMED", recordId: id, confirmedAt: Date.now() };
  wx.setStorageSync(key(recordType), confirmed);
  const saved = read(recordType);
  if (!saved || saved.state !== "CONFIRMED" || saved.recordId !== id || saved.clientRequestId !== intent.clientRequestId) {
    throw new Error("无法保存工单完成状态，已保持防重复提交锁");
  }
  return saved;
}
function acknowledge(recordType, recordId, clientRequestId) {
  const intent = read(recordType);
  if (!intent) return true;
  if (intent.state !== "CONFIRMED" || String(intent.recordId || "") !== String(recordId || "")
      || String(intent.clientRequestId || "") !== String(clientRequestId || "")) return false;
  return clear(recordType);
}
async function recover(recordType) {
  const intent = read(recordType);
  if (!intent) return { found: false, complete: false };
  return callFace("recoverBusinessSubmission", { recordType: intent.recordType, clientRequestId: intent.clientRequestId, storeId: intent.storeId });
}

module.exports = { begin, read, markUncertain, confirm, acknowledge, clear, recover };

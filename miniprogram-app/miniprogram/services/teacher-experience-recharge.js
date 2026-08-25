const { readSession } = require("./session");

const PREFIX = "lusizhuoerMiniTeacherExperienceRechargeV1:";

function clean(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value) {
  const source = stable(value);
  let result = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    result ^= source.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
function storageKey() {
  const session = readSession();
  const uid = clean(session && session.uid);
  if (!uid) throw new Error("登录状态已经失效");
  return `${PREFIX}${uid}`;
}
function requestId() {
  const random = Math.random().toString(36).slice(2, 14).padEnd(12, "0");
  return `mp_teacher_quota_${Date.now().toString(36)}_${random}`.slice(0, 64);
}
function payload(value = {}) {
  const teacherId = clean(value.teacherId);
  const productId = clean(value.productId);
  const unitCount = Number(value.unitCount);
  const note = clean(value.note);
  if (!/^\d+$/.test(teacherId) || !/^\d+$/.test(productId)
      || !Number.isInteger(unitCount) || unitCount < 1 || unitCount > 99999 || note.length > 500) {
    throw new Error("体验充值资料无效，已禁止提交");
  }
  return Object.freeze({ teacherId, productId, unitCount, note });
}
function read() {
  const value = wx.getStorageSync(storageKey());
  return value && typeof value === "object" && clean(value.clientRequestId) ? value : null;
}
function persist(intent) {
  wx.setStorageSync(storageKey(), intent);
  const saved = read();
  if (!saved || saved.clientRequestId !== intent.clientRequestId || saved.fingerprint !== intent.fingerprint) {
    throw new Error("无法保存体验充值防重复提交锁，已禁止提交");
  }
  return saved;
}
function begin(value) {
  const exactPayload = payload(value);
  const fingerprint = hash(exactPayload);
  const existing = read();
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error("上一笔体验充值结果尚未确认，禁止用新资料重复充值。请先确认上次结果");
    }
    return existing;
  }
  return persist({
    ...exactPayload,
    fingerprint,
    clientRequestId: requestId(),
    state: "SUBMITTING",
    createdAt: Date.now()
  });
}
function markUncertain(clientRequestId) {
  const intent = read();
  if (!intent || intent.clientRequestId !== clean(clientRequestId)) return false;
  if (intent.state === "CONFIRMED") return true;
  persist({ ...intent, state: "UNCERTAIN", updatedAt: Date.now() });
  return true;
}
function confirm(clientRequestId, rechargeId) {
  const intent = read();
  const expectedRequestId = clean(clientRequestId);
  const exactRechargeId = clean(rechargeId);
  if (!intent || intent.clientRequestId !== expectedRequestId || !exactRechargeId) {
    throw new Error("无法确认体验充值结果，已保持防重复提交锁");
  }
  return persist({ ...intent, state: "CONFIRMED", rechargeId: exactRechargeId, confirmedAt: Date.now() });
}
function acknowledge(clientRequestId, rechargeId) {
  const intent = read();
  if (!intent || intent.state !== "CONFIRMED"
      || intent.clientRequestId !== clean(clientRequestId)
      || clean(intent.rechargeId) !== clean(rechargeId)) return false;
  wx.removeStorageSync(storageKey());
  if (read()) throw new Error("无法清除体验充值防重复提交锁，已禁止继续充值");
  return true;
}
function clearRejected(clientRequestId) {
  const intent = read();
  if (!intent || intent.state === "CONFIRMED" || intent.clientRequestId !== clean(clientRequestId)) return false;
  wx.removeStorageSync(storageKey());
  if (read()) throw new Error("无法清除已拒绝的体验充值锁");
  return true;
}

module.exports = { begin, read, markUncertain, confirm, acknowledge, clearRejected };

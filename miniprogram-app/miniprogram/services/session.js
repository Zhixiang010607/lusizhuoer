const { getAuth } = require("./cloudbase");
const { callStaff } = require("./api");

const SESSION_KEY = "lusizhuoerMiniSessionV1";
const STORE_KEY_PREFIX = "lusizhuoerMiniStoreV1:";
const ROLES = new Set(["hq", "store", "teacher"]);

function normalizePhone(value) {
  const phone = String(value || "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error("请输入有效的中国大陆手机号");
  return phone;
}

function readSession() {
  const value = wx.getStorageSync(SESSION_KEY);
  return value && typeof value === "object" ? value : null;
}

function writeSession(value) {
  wx.setStorageSync(SESSION_KEY, value);
  const app = getAppSafe();
  if (app) app.globalData.session = value;
  return value;
}

function getAppSafe() {
  try { return getApp(); } catch (_) { return null; }
}

async function passwordLogin(phoneValue, password) {
  const phone = normalizePhone(phoneValue);
  if (!password) throw new Error("请输入登录密码");
  const auth = getAuth();
  let identity;
  if (typeof auth.signInWithPassword === "function") {
    const result = await auth.signInWithPassword({ phone, password });
    if (result && result.error) throw new Error(result.error.message || "手机号或密码错误");
    identity = result && result.data ? result.data : result;
  } else if (typeof auth.signIn === "function") {
    identity = await auth.signIn({ username: phone, password });
  } else {
    throw new Error("当前 CloudBase SDK 不支持账号密码登录，请检查 npm 依赖版本");
  }
  const staff = await callStaff("session", { phone });
  const profile = staff.profile || {};
  if (!ROLES.has(String(profile.role || ""))) throw new Error("该手机号尚未绑定可用业务身份");
  const uid = String(staff.uid || identity && identity.user && (identity.user.uid || identity.user.id) || "");
  if (!uid) throw new Error("登录成功但没有取得 CloudBase UID，已禁止进入工作台");
  const session = {
    uid,
    phone,
    role: String(profile.role),
    staffId: String(profile.staffId || ""),
    staffCode: String(profile.staffCode || ""),
    staffName: String(profile.staffName || ""),
    storeId: String(profile.storeId || ""),
    storeCode: String(profile.storeCode || ""),
    storeName: String(profile.storeName || ""),
    loginAt: new Date().toISOString()
  };
  if (session.role === "store" && !session.storeId) throw new Error("门店账号未绑定有效门店");
  return writeSession(session);
}

async function restoreAndValidateSession() {
  const stored = readSession();
  if (!stored || !stored.phone || !stored.uid || !ROLES.has(stored.role)) return null;
  const staff = await callStaff("session", { phone: normalizePhone(stored.phone) });
  const profile = staff.profile || {};
  if (String(staff.uid || "") !== stored.uid || String(profile.role || "") !== stored.role) {
    clearSession();
    throw new Error("账号身份已经变化，请重新登录");
  }
  if (stored.role === "store" && String(profile.storeId || "") !== stored.storeId) {
    clearSession();
    throw new Error("门店绑定已经变化，请重新登录");
  }
  return writeSession({ ...stored, staffName: String(profile.staffName || stored.staffName || "") });
}

function requireSession(allowedRoles) {
  const session = readSession();
  if (!session) {
    wx.reLaunch({ url: "/pages/login/index" });
    return null;
  }
  if (Array.isArray(allowedRoles) && !allowedRoles.includes(session.role)) {
    wx.showToast({ title: "当前身份无权使用", icon: "none" });
    wx.reLaunch({ url: "/pages/home/index" });
    return null;
  }
  return session;
}

function selectedStoreKey(session) { return `${STORE_KEY_PREFIX}${session.uid}`; }
function getSelectedStore(session = readSession()) {
  if (!session) return null;
  if (session.role === "store") return { id: session.storeId, code: session.storeCode, name: session.storeName };
  const value = wx.getStorageSync(selectedStoreKey(session));
  return value && typeof value === "object" && value.id ? value : null;
}
function setSelectedStore(store, session = readSession()) {
  if (!session || session.role !== "teacher") return;
  wx.setStorageSync(selectedStoreKey(session), { id: String(store.id), code: String(store.code || ""), name: String(store.name || "") });
}

function clearSession() {
  const stored = readSession();
  wx.removeStorageSync(SESSION_KEY);
  if (stored && stored.uid) wx.removeStorageSync(selectedStoreKey(stored));
  const app = getAppSafe();
  if (app) app.globalData.session = null;
}

async function signOut() {
  try {
    const auth = getAuth();
    if (auth && typeof auth.signOut === "function") await auth.signOut();
  } finally { clearSession(); }
}

module.exports = {
  passwordLogin, restoreAndValidateSession, requireSession, readSession,
  getSelectedStore, setSelectedStore, clearSession, signOut, normalizePhone
};

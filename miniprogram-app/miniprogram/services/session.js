const { getAuth } = require("./cloudbase");
const { callStaff } = require("./api");

const SESSION_KEY = "lusizhuoerMiniSessionV1";
const STORE_KEY_PREFIX = "lusizhuoerMiniStoreV1:";
const SMS_COOLDOWN_KEY_PREFIX = "lusizhuoerMiniSmsCooldownV1:";
const SMS_COOLDOWN_MS = 60 * 1000;
const ROLES = new Set(["hq", "store", "teacher"]);
let passwordResetVerifier = null;

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

function identityUid(result) {
  const identity = result && result.data ? result.data : result || {};
  const user = identity.user || identity.session && identity.session.user || {};
  return String(user.uid || user.id || user.sub || "");
}

function loginError(result, fallback) {
  if (!result || !result.error) return null;
  const source = result.error;
  const message = String(source.message || source.error_description || "").trim();
  const category = String(source.category || source.code || source.status || "").toUpperCase();
  const configurationMessage = category === "UNKNOWN" && !message
    ? "登录服务暂不可用，请检查网络和小程序 request 合法域名配置"
    : "";
  const error = new Error(message || configurationMessage || fallback);
  error.code = source.code || source.status || source.category || "AUTH_FAILED";
  return error;
}

function businessSession(staff, authenticatedUid, loginAt = new Date().toISOString()) {
  const profile = staff.profile || {};
  if (!ROLES.has(String(profile.role || ""))) throw new Error("当前登录身份尚未绑定可用业务身份");
  const uid = String(staff.uid || "");
  if (!uid || !authenticatedUid) throw new Error("登录成功但没有取得完整 CloudBase UID，已禁止进入工作台");
  if (uid !== String(authenticatedUid)) throw new Error("CloudBase 登录身份与业务身份不一致，已禁止进入工作台");
  const session = {
    uid,
    role: String(profile.role),
    staffId: String(profile.staffId || ""),
    staffCode: String(profile.staffCode || ""),
    staffName: String(profile.staffName || ""),
    teacherId: String(profile.teacherId || ""),
    storeId: String(profile.storeId || ""),
    storeCode: String(profile.storeCode || ""),
    storeName: String(profile.storeName || ""),
    loginAt
  };
  if (session.role === "store" && !session.storeId) throw new Error("门店账号未绑定有效门店");
  if (session.role === "teacher" && !session.teacherId) throw new Error("老师账号未绑定有效老师身份");
  return writeSession(session);
}

async function clearFailedLogin(auth) {
  try {
    if (auth && typeof auth.signOut === "function") await auth.signOut();
  } catch (_) {}
  clearSession();
}

async function finishAuthenticatedLogin(auth, result, fallback) {
  const resultError = loginError(result, fallback);
  if (resultError) {
    await clearFailedLogin(auth);
    throw resultError;
  }
  const authenticatedUid = identityUid(result);
  try {
    const staff = await callStaff("session");
    return businessSession(staff, authenticatedUid);
  } catch (error) {
    await clearFailedLogin(auth);
    throw error;
  }
}

async function signInAndFinish(auth, authenticate, fallback) {
  let result;
  try {
    result = await authenticate();
  } catch (error) {
    await clearFailedLogin(auth);
    throw error;
  }
  return finishAuthenticatedLogin(auth, result, fallback);
}

async function passwordLogin(phoneValue, password) {
  const phone = normalizePhone(phoneValue);
  if (!password) throw new Error("请输入登录密码");
  const auth = getAuth();
  if (typeof auth.signInWithPassword === "function") {
    return signInAndFinish(auth, () => auth.signInWithPassword({ phone, password }), "手机号或密码错误");
  } else if (typeof auth.signIn === "function") {
    return signInAndFinish(auth, () => auth.signIn({ username: phone, password }), "手机号或密码错误");
  } else {
    throw new Error("当前 CloudBase SDK 不支持账号密码登录，请检查 npm 依赖版本");
  }
}

async function wechatPhoneLogin(phoneCodeValue) {
  const phoneCode = String(phoneCodeValue || "").trim();
  if (!phoneCode) throw new Error("请先同意使用微信绑定手机号");
  const auth = getAuth();
  if (typeof auth.signInWithPhoneAuth !== "function") {
    throw new Error("当前 CloudBase SDK 不支持微信手机号登录，请检查 npm 依赖版本");
  }
  return signInAndFinish(auth, () => auth.signInWithPhoneAuth({ phoneCode }), "微信手机号登录失败");
}

function authData(result, fallback) {
  if (!result || typeof result !== "object") {
    throw new Error(`${fallback}，认证服务没有返回有效结果`);
  }
  const error = loginError(result, fallback);
  if (error) throw error;
  if (!result.data || typeof result.data !== "object") {
    throw new Error(`${fallback}，认证服务没有返回有效会话`);
  }
  return result.data;
}

function passwordResetCooldownRemaining(phoneValue) {
  let phone;
  try { phone = normalizePhone(phoneValue); } catch (_) { return 0; }
  const key = `${SMS_COOLDOWN_KEY_PREFIX}${phone}`;
  const state = wx.getStorageSync(key);
  const remaining = Math.max(0, Math.ceil((Number(state && state.lastSentAt || 0) + SMS_COOLDOWN_MS - Date.now()) / 1000));
  if (!remaining) wx.removeStorageSync(key);
  return remaining;
}

async function requestPasswordResetCode(phoneValue) {
  const phone = normalizePhone(phoneValue);
  const remaining = passwordResetCooldownRemaining(phone);
  if (remaining > 0) throw new Error(`验证码已发送，请 ${remaining} 秒后再试`);
  const auth = getAuth();
  if (typeof auth.signInWithOtp !== "function") throw new Error("当前 CloudBase SDK 不支持短信验证，请检查 npm 依赖版本");
  const result = await auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
  const data = authData(result, "验证码发送失败");
  if (typeof data.verifyOtp !== "function") throw new Error("验证码服务未返回验证会话");
  passwordResetVerifier = data.verifyOtp;
  wx.setStorageSync(`${SMS_COOLDOWN_KEY_PREFIX}${phone}`, { lastSentAt: Date.now() });
  return true;
}

async function completePasswordReset(codeValue, newPassword) {
  const code = String(codeValue || "").trim();
  if (!passwordResetVerifier) throw new Error("请先获取短信验证码");
  if (!/^\d{4,8}$/.test(code)) throw new Error("请输入有效短信验证码");
  const auth = getAuth();
  let verified = false;
  try {
    const result = await passwordResetVerifier({ token: code });
    authData(result, "验证码无效或已过期");
    verified = true;
    await callStaff("changeOwnPassword", { newPassword });
    passwordResetVerifier = null;
    return true;
  } finally {
    if (verified) await clearFailedLogin(auth);
  }
}

async function restoreAndValidateSession() {
  const stored = readSession();
  if (!stored || !stored.uid || !ROLES.has(stored.role)) return null;
  try {
    const staff = await callStaff("session");
    const profile = staff.profile || {};
    if (String(staff.uid || "") !== stored.uid || String(profile.role || "") !== stored.role) {
      throw new Error("账号身份已经变化，请重新登录");
    }
    if (stored.role === "store" && String(profile.storeId || "") !== stored.storeId) {
      throw new Error("门店绑定已经变化，请重新登录");
    }
    if (stored.role === "teacher" && String(profile.teacherId || "") !== stored.teacherId) {
      throw new Error("老师绑定已经变化，请重新登录");
    }
    return businessSession(staff, stored.uid, stored.loginAt || new Date().toISOString());
  } catch (error) {
    clearSession();
    throw error;
  }
}

async function waitForStartupSession() {
  const app = getAppSafe();
  const startupPromise = app && app.globalData ? app.globalData.startupPromise : null;
  if (startupPromise && typeof startupPromise.then === "function") {
    try { await startupPromise; } catch (_) {}
  }
  return app && app.globalData && app.globalData.startupReady === true
    ? app.globalData.session || null
    : null;
}

function requireSession(allowedRoles) {
  const app = getAppSafe();
  const hasAppHarness = Boolean(app && app.globalData);
  const session = hasAppHarness
    ? (app.globalData.startupReady === true ? app.globalData.session : null)
    : readSession();
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
  passwordLogin, wechatPhoneLogin, requestPasswordResetCode, completePasswordReset,
  passwordResetCooldownRemaining,
  restoreAndValidateSession, waitForStartupSession, requireSession, readSession,
  getSelectedStore, setSelectedStore, clearSession, signOut, normalizePhone
};

(() => {
  "use strict";
  let app = null;
  let auth = null;
  let verifyOtp = null;
  const SMS_COOLDOWN_MS = 60 * 1000;

  function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error("请输入有效的中国大陆手机号");
    // CloudBase Web SDK 的 phone 参数使用 11 位中国大陆手机号；国家码不需写入。
    return digits;
  }

  function getApp() {
    if (app) return app;
    if (!window.cloudbase || !window.registerAuth || !window.registerFunctions || !window.CloudBaseAuthConfig) {
      throw new Error("CloudBase 登录组件未加载，请刷新后重试");
    }
    window.registerAuth(window.cloudbase);
    window.registerFunctions(window.cloudbase);
    app = window.cloudbase.init(window.CloudBaseAuthConfig);
    return app;
  }

  function getAuth() {
    if (auth) return auth;
    auth = getApp().auth();
    return auth;
  }

  function functionPayload(result) {
    const candidates = [result?.result, result?.data?.result, result?.data, result].map((candidate) => {
      if (typeof candidate !== "string") return candidate;
      try { return JSON.parse(candidate); } catch (_) { return candidate; }
    });
    return candidates.find((candidate) => candidate && typeof candidate === "object" && (
      Object.prototype.hasOwnProperty.call(candidate, "ok") ||
      Object.prototype.hasOwnProperty.call(candidate, "message") ||
      Object.prototype.hasOwnProperty.call(candidate, "errMsg") ||
      Object.prototype.hasOwnProperty.call(candidate, "error")
    )) || {};
  }

  function functionFailureMessage(result, payload, fallback) {
    const detail = payload?.message || payload?.error?.message || payload?.errMsg ||
      result?.message || result?.error?.message || result?.errMsg || fallback;
    const code = payload?.code || payload?.error?.code || result?.code || result?.error?.code;
    const stage = payload?.stage || result?.stage;
    const requestId = payload?.requestId || result?.requestId;
    const diagnostic = [code, stage, requestId].filter(Boolean).join(" · ");
    return diagnostic ? `${detail}（${diagnostic}）` : detail;
  }

  async function callStaffAccount(data, fallback) {
    let result;
    try {
      result = await getApp().callFunction({ name: "staffAccount", data });
    } catch (error) {
      throw new Error(error?.message || fallback);
    }
    const payload = functionPayload(result);
    if (!payload?.ok) {
      const error = new Error(functionFailureMessage(result, payload, fallback));
      Object.assign(error, {
        code: payload?.code || result?.code,
        stage: payload?.stage || result?.stage,
        requestId: payload?.requestId || result?.requestId,
        storeId: payload?.storeId || result?.storeId,
        storeCode: payload?.storeCode || result?.storeCode
      });
      throw error;
    }
    return payload;
  }

  function smsStateKey(phone) { return `lusizhuoerSmsState:${phone}`; }
  function readSmsState(phone) {
    try { return JSON.parse(localStorage.getItem(smsStateKey(phone)) || "{}"); } catch (_) { return {}; }
  }
  function writeSmsState(phone, state) {
    localStorage.setItem(smsStateKey(phone), JSON.stringify(state));
  }
  function cooldownRemaining(phone) {
    const state = readSmsState(normalizePhone(phone));
    return Math.max(0, Math.ceil((Number(state.lastSentAt || 0) + SMS_COOLDOWN_MS - Date.now()) / 1000));
  }

  window.CloudBasePhoneAuth = {
    async sendCode(phone) {
      const normalizedPhone = normalizePhone(phone);
      const state = readSmsState(normalizedPhone);
      const remaining = cooldownRemaining(normalizedPhone);
      if (remaining > 0) throw new Error(`验证码已发送，请 ${remaining} 秒后再试`);
      const result = await getAuth().signInWithOtp({
        phone: normalizedPhone,
        options: { shouldCreateUser: false }
      });
      if (result.error) throw new Error(result.error.message || "验证码发送失败");
      verifyOtp = result.data?.verifyOtp;
      if (!verifyOtp) throw new Error("验证码服务未返回验证会话");
      writeSmsState(normalizedPhone, { lastSentAt: Date.now() });
    },
    async signInWithCode(code) {
      if (!verifyOtp) throw new Error("请先获取短信验证码");
      const result = await verifyOtp({ token: String(code || "").trim() });
      if (result.error) throw new Error(result.error.message || "验证码无效或已过期");
      return result.data;
    },
    async signInWithPassword(phone, password) {
      const result = await getAuth().signInWithPassword({ phone: normalizePhone(phone), password });
      if (result.error) throw new Error(result.error.message || "手机号或密码错误");
      return result.data;
    },
    async getStaffSession(phone) {
      const data = await callStaffAccount(
        { action: "session", phone: normalizePhone(phone) },
        "该手机号尚未被总部绑定业务身份"
      );
      if (!data?.profile?.role) throw new Error("该手机号尚未被总部绑定业务身份");
      return data;
    },
    async bootstrapHq() {
      return callStaffAccount({ action: "bootstrapHq" }, "总部初始化未获授权");
    },
    async provisionStaff({ staffName, phone, role, initialPassword, storeId = "" }) {
      return callStaffAccount(
        { action: "provisionStaff", staffName, phone: normalizePhone(phone), role, initialPassword, storeId },
        "员工账号创建失败"
      );
    },
    async createStoreWithAccount({ storeName, province, city, district, addressDetail, contactName, contactPhone, initialPassword, existingStoreId = "" }) {
      return callStaffAccount(
        {
          action: "createStoreWithAccount",
          storeName,
          province,
          city,
          district,
          addressDetail,
          contactName,
          contactPhone: normalizePhone(contactPhone),
          initialPassword,
          existingStoreId
        },
        "门店与登录账号创建失败"
      );
    },
    async changeOwnPassword(newPassword) {
      return callStaffAccount({ action: "changeOwnPassword", newPassword }, "密码修改失败");
    },
    async resetStaffPassword({ uid, newPassword }) {
      return callStaffAccount({ action: "resetPassword", uid, newPassword }, "密码重置失败");
    },
    async setStaffStatus({ uid = "", phone = "", status }) {
      return callStaffAccount({ action: "setStaffStatus", uid, phone, status }, "人员状态更新失败");
    },
    async listStaff(role) {
      const data = await callStaffAccount({ action: "listStaff", role }, "人员列表读取失败");
      return data.staff || [];
    },
    async listStores() {
      const data = await callStaffAccount({ action: "listStores" }, "门店列表读取失败");
      return data.stores || [];
    },
    smsCooldownRemaining(phone) { return cooldownRemaining(phone); }
  };
})();

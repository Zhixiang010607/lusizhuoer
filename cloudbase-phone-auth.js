(() => {
  "use strict";
  let app = null;
  let auth = null;
  let verifyOtp = null;
  const SMS_COOLDOWN_MS = 60 * 1000;
  const AUTH_CHANNEL_NAME = "lusizhuoer-auth-session-v1";
  const AUTH_STATE_KEY = "lusizhuoerActiveAuth";

  function registerCloudBaseComponent(register, componentName) {
    try {
      register(window.cloudbase);
    } catch (error) {
      const detail = String(error?.message || error || "").toLowerCase();
      const alreadyRegistered = detail.includes("duplicate component") && detail.includes(componentName);
      if (!alreadyRegistered) throw error;
    }
  }

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
    // Depending on the CDN bundle/version, auth and functions may already be
    // registered when their scripts load. Re-registering them aborts every
    // CloudBase request with INVALID_OPERATION, so only ignore that exact,
    // harmless duplicate-registration condition.
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
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
        storeCode: payload?.storeCode || result?.storeCode,
        storeRolledBack: payload?.storeRolledBack || result?.storeRolledBack,
        causeCode: payload?.causeCode || result?.causeCode,
        causeMessage: payload?.causeMessage || result?.causeMessage
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

  function announceAuthEvent(type, session = null) {
    const state = {
      type,
      uid: String(session?.cloudbaseUserId || ""),
      role: String(session?.role || ""),
      store: String(session?.store || ""),
      sessionId: String(session?.sessionId || ""),
      occurredAt: Date.now()
    };
    try {
      if (type === "SIGNED_IN") localStorage.setItem(AUTH_STATE_KEY, JSON.stringify(state));
      else localStorage.removeItem(AUTH_STATE_KEY);
    } catch (_) { /* storage may be unavailable */ }
    if (typeof window.BroadcastChannel !== "function") return;
    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    try {
      channel.postMessage(state);
    } finally {
      channel.close();
    }
  }

  function sessionChanged(message) {
    const error = new Error(message);
    error.code = "AUTH_SESSION_CHANGED";
    return error;
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
    async validateWorkspaceSession(expectedSession) {
      const expected = expectedSession && typeof expectedSession === "object" ? expectedSession : {};
      const account = expected.phone || expected.account;
      if (!account || !expected.cloudbaseUserId || !expected.role) {
        throw sessionChanged("当前页面登录信息不完整，请重新登录");
      }
      const data = await this.getStaffSession(account);
      const profile = data?.profile || {};
      const currentUid = String(data?.uid || "");
      const expectedUid = String(expected.cloudbaseUserId || "");
      const currentRole = String(profile.role || "").toLowerCase();
      const expectedRole = String(expected.role || "").toLowerCase();
      const currentStore = String(profile.storeId || "");
      const expectedStore = String(expected.store || "");
      if (!currentUid || currentUid !== expectedUid) {
        throw sessionChanged("此浏览器已经切换到另一个登录账号");
      }
      if (!currentRole || currentRole !== expectedRole) {
        throw sessionChanged("当前云端账号身份与本页面不一致");
      }
      if (expectedRole === "store" && (!currentStore || currentStore !== expectedStore)) {
        throw sessionChanged("当前门店账号与本页面门店不一致");
      }
      return data;
    },
    announceWorkspaceSession(session) {
      announceAuthEvent("SIGNED_IN", session);
    },
    announceAuthenticationChanged() {
      announceAuthEvent("AUTH_CHANGED");
    },
    async signOut() {
      try {
        const result = await getAuth().signOut();
        if (result?.error) throw new Error(result.error.message || "退出登录失败");
      } finally {
        announceAuthEvent("SIGNED_OUT");
      }
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
    async getHqDashboard({ startDate, endDate } = {}) {
      return callStaffAccount(
        { action: "getHqDashboard", startDate, endDate },
        "总部首页数据库统计读取失败"
      );
    },
    async createProduct({ productName, productType, description = "", clientRequestId = "" }) {
      return callStaffAccount(
        { action: "createProduct", productName, productType, description, clientRequestId },
        "产品创建失败"
      );
    },
    async listProducts() {
      const data = await callStaffAccount({ action: "listProducts" }, "产品列表读取失败");
      return data.products || [];
    },
    async setProductStatus({ productRef, status }) {
      return callStaffAccount(
        { action: "setProductStatus", productRef, status },
        "产品状态更新失败"
      );
    },
    async voidVerification({ verificationId, voidNote = "" }) {
      return callStaffAccount(
        { action: "voidVerification", verificationId, voidNote },
        "核销作废申请提交失败"
      );
    },
    async requestOrderVoid({ recordType, recordId, note }) {
      return callStaffAccount(
        { action: "requestOrderVoid", recordType, recordId, note },
        "作废申请提交失败"
      );
    },
    async listReviewOrders({ recordType, recordId = "", recordCode = "", storeId = "", applicationType = "", status = "", limit = 200, paged = false, cursor = null } = {}) {
      const payload = { action: "listReviewOrders", recordType, recordId, recordCode, storeId, applicationType, status, limit, paged };
      if (cursor) {
        payload.cursorPending = cursor.pending;
        payload.cursorApplicationTime = cursor.applicationTime || "";
        payload.cursorId = cursor.id || "";
      }
      const data = await callStaffAccount(
        payload,
        "审核工单读取失败"
      );
      return paged
        ? { orders: data.orders || [], hasMore: data.hasMore === true, nextCursor: data.nextCursor || null, stores: data.stores || [] }
        : data.orders || [];
    },
    async reviewOrder({ recordType, recordId, decision, note }) {
      return callStaffAccount(
        { action: "reviewOrder", recordType, recordId, decision, note },
        "工单审核失败"
      );
    },
    smsCooldownRemaining(phone) { return cooldownRemaining(phone); }
  };
})();

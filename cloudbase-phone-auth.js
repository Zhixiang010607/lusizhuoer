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
      const result = await getApp().callFunction({ name: "staffAccount", data: { action: "session", phone: normalizePhone(phone) } });
      const data = result?.result || result?.data?.result || result?.data;
      if (!data?.ok || !data?.profile?.role) {
        throw new Error(data?.message || "该手机号尚未被总部绑定业务身份");
      }
      return data;
    },
    async bootstrapHq() {
      const result = await getApp().callFunction({ name: "staffAccount", data: { action: "bootstrapHq" } });
      const data = result?.result || result?.data?.result || result?.data;
      if (!data?.ok) throw new Error(data?.message || "总部初始化未获授权");
      return data;
    },
    async provisionStaff({ staffName, phone, role, initialPassword, storeId = "" }) {
      const result = await getApp().callFunction({
        name: "staffAccount",
        data: { action: "provisionStaff", staffName, phone: normalizePhone(phone), role, initialPassword, storeId }
      });
      const data = result?.result || result?.data?.result || result?.data;
      if (!data?.ok) throw new Error(data?.message || "员工账号创建失败");
      return data;
    },
    async setStaffStatus({ uid = "", phone = "", status }) {
      const result = await getApp().callFunction({ name: "staffAccount", data: { action: "setStaffStatus", uid, phone, status } });
      const data = result?.result || result?.data?.result || result?.data;
      if (!data?.ok) throw new Error(data?.message || "人员状态更新失败");
      return data;
    },
    smsCooldownRemaining(phone) { return cooldownRemaining(phone); }
  };
})();

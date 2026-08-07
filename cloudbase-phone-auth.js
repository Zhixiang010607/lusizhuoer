(() => {
  "use strict";
  let app = null;
  let auth = null;
  let verifyOtp = null;

  function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error("请输入有效的中国大陆手机号");
    // CloudBase Web SDK 的 phone 参数使用 11 位中国大陆手机号；国家码不需写入。
    return digits;
  }

  function getApp() {
    if (app) return app;
    if (!window.cloudbase || !window.registerAuth || !window.CloudBaseAuthConfig) {
      throw new Error("CloudBase 登录组件未加载，请刷新后重试");
    }
    window.registerAuth(window.cloudbase);
    app = window.cloudbase.init(window.CloudBaseAuthConfig);
    return app;
  }

  function getAuth() {
    if (auth) return auth;
    auth = getApp().auth();
    return auth;
  }

  window.CloudBasePhoneAuth = {
    async sendCode(phone) {
      const result = await getAuth().signInWithOtp({
        phone: normalizePhone(phone),
        options: { shouldCreateUser: false }
      });
      if (result.error) throw new Error(result.error.message || "验证码发送失败");
      verifyOtp = result.data?.verifyOtp;
      if (!verifyOtp) throw new Error("验证码服务未返回验证会话");
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
    async getStaffSession() {
      const result = await getApp().callFunction({ name: "staffAccount", data: { action: "session" } });
      const data = result?.result || result?.data?.result || result?.data;
      if (!data?.ok || !data?.profile?.role) {
        throw new Error(data?.message || "该手机号尚未被总部绑定业务身份");
      }
      return data;
    }
  };
})();

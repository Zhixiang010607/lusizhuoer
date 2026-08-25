const { passwordLogin, wechatPhoneLogin, waitForStartupSession } = require("../../services/session");

Page({
  data: { phone: "", password: "", passwordVisible: false, busy: false, startupChecking: false, message: "", error: false },
  async onShow() {
    const epoch = Number(this._startupEpoch || 0) + 1;
    this._startupEpoch = epoch;
    this.setData({ startupChecking: true });
    const session = await waitForStartupSession();
    if (epoch !== this._startupEpoch) return;
    this.setData({ startupChecking: false });
    if (session) wx.reLaunch({ url: "/pages/home/index" });
  },
  onUnload() { this._startupEpoch = Number(this._startupEpoch || 0) + 1; },
  inputPhone(event) { this.setData({ phone: event.detail.value }); },
  inputPassword(event) { this.setData({ password: event.detail.value }); },
  togglePassword() { this.setData({ passwordVisible: !this.data.passwordVisible }); },
  openPasswordReset() {
    if (this.data.busy || this.data.startupChecking) return;
    const phone = String(this.data.phone || "").replace(/\D/g, "");
    const query = /^1[3-9]\d{9}$/.test(phone) ? `?phone=${encodeURIComponent(phone)}` : "";
    wx.navigateTo({ url: `/pages/password-reset/index${query}` });
  },
  async submitWechatPhone(event) {
    if (this.data.busy || this.data.startupChecking) return;
    const phoneCode = String(event && event.detail && event.detail.code || "").trim();
    if (!phoneCode) {
      this.setData({ message: "需要你同意使用微信绑定手机号，才能快捷登录", error: true });
      return;
    }
    this.setData({ busy: true, message: "正在验证微信手机号和业务身份…", error: false });
    try {
      const session = await wechatPhoneLogin(phoneCode);
      this.setData({ password: "", message: `欢迎 ${session.staffName || "登录账号"}`, error: false });
      wx.reLaunch({ url: "/pages/home/index" });
    } catch (error) {
      this.setData({ password: "", message: error.message || "微信手机号登录失败", error: true });
    } finally { this.setData({ busy: false }); }
  },
  async submit() {
    if (this.data.busy || this.data.startupChecking) return;
    this.setData({ busy: true, message: "正在验证账号和业务身份…", error: false });
    try {
      const session = await passwordLogin(this.data.phone, this.data.password);
      this.setData({ password: "", message: `欢迎 ${session.staffName || "登录账号"}`, error: false });
      wx.reLaunch({ url: "/pages/home/index" });
    } catch (error) {
      this.setData({ password: "", message: error.message || "登录失败", error: true });
    } finally { this.setData({ busy: false }); }
  }
});

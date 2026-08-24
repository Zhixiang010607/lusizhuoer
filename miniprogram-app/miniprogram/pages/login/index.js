const { passwordLogin, wechatPhoneLogin, readSession } = require("../../services/session");

Page({
  data: { phone: "", password: "", passwordVisible: false, busy: false, message: "", error: false },
  onShow() {
    if (readSession()) wx.reLaunch({ url: "/pages/home/index" });
  },
  inputPhone(event) { this.setData({ phone: event.detail.value }); },
  inputPassword(event) { this.setData({ password: event.detail.value }); },
  togglePassword() { this.setData({ passwordVisible: !this.data.passwordVisible }); },
  async submitWechatPhone(event) {
    if (this.data.busy) return;
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
    if (this.data.busy) return;
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

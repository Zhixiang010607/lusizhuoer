const { passwordLogin, readSession } = require("../../services/session");

Page({
  data: { phone: "", password: "", passwordVisible: false, busy: false, message: "", error: false },
  onShow() {
    if (readSession()) wx.reLaunch({ url: "/pages/home/index" });
  },
  inputPhone(event) { this.setData({ phone: event.detail.value }); },
  inputPassword(event) { this.setData({ password: event.detail.value }); },
  togglePassword() { this.setData({ passwordVisible: !this.data.passwordVisible }); },
  async submit() {
    if (this.data.busy) return;
    this.setData({ busy: true, message: "正在验证账号和业务身份…", error: false });
    try {
      const session = await passwordLogin(this.data.phone, this.data.password);
      this.setData({ password: "", message: `欢迎 ${session.staffName || session.phone}`, error: false });
      wx.reLaunch({ url: "/pages/home/index" });
    } catch (error) {
      this.setData({ password: "", message: error.message || "登录失败", error: true });
    } finally { this.setData({ busy: false }); }
  }
});

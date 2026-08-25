const { requestPasswordResetCode, completePasswordReset, passwordResetCooldownRemaining } = require("../../services/session");

function validPassword(value) {
  const password = String(value || "");
  const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(password)).length;
  return password.length >= 8 && password.length <= 32 && groups >= 3;
}

Page({
  data: {
    phone: "", code: "", newPassword: "", confirmation: "",
    newVisible: false, confirmationVisible: false,
    busy: false, sending: false, cooldown: 0, message: "", error: false
  },
  onLoad(options = {}) {
    const phone = String(options.phone || "").replace(/\D/g, "").slice(0, 11);
    this.setData({ phone }, () => this.refreshCooldown());
  },
  onUnload() { if (this.cooldownTimer) clearInterval(this.cooldownTimer); },
  inputPhone(event) { this.setData({ phone: event.detail.value }, () => this.refreshCooldown()); },
  inputCode(event) { this.setData({ code: event.detail.value }); },
  inputNewPassword(event) { this.setData({ newPassword: event.detail.value }); },
  inputConfirmation(event) { this.setData({ confirmation: event.detail.value }); },
  toggleNewPassword() { this.setData({ newVisible: !this.data.newVisible }); },
  toggleConfirmation() { this.setData({ confirmationVisible: !this.data.confirmationVisible }); },
  refreshCooldown() {
    const remaining = passwordResetCooldownRemaining(this.data.phone);
    if (remaining > 0) this.startCooldown(remaining);
    else if (this.data.cooldown > 0) {
      if (this.cooldownTimer) clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
      this.setData({ cooldown: 0 });
    }
  },
  startCooldown(seconds = 60) {
    if (this.cooldownTimer) clearInterval(this.cooldownTimer);
    this.setData({ cooldown: Math.max(1, Number(seconds || 60)) });
    this.cooldownTimer = setInterval(() => {
      const next = Math.max(0, Number(this.data.cooldown || 0) - 1);
      this.setData({ cooldown: next });
      if (!next) { clearInterval(this.cooldownTimer); this.cooldownTimer = null; }
    }, 1000);
  },
  async sendCode() {
    if (this.data.busy || this.data.sending || this.data.cooldown > 0) return;
    this.setData({ sending: true, message: "正在发送验证码…", error: false });
    try {
      await requestPasswordResetCode(this.data.phone);
      this.startCooldown(passwordResetCooldownRemaining(this.data.phone) || 60);
      this.setData({ message: "露思卓儿验证码已发送。60 秒内不能重复发送，请尽快完成修改。", error: false });
    } catch (error) {
      this.setData({ message: error.message || "验证码发送失败", error: true });
    } finally { this.setData({ sending: false }); }
  },
  async submit() {
    if (this.data.busy) return;
    if (!this.data.code.trim()) return this.setData({ message: "请输入短信验证码", error: true });
    if (!validPassword(this.data.newPassword)) return this.setData({ message: "新密码需为 8–32 位，且至少包含三类字符", error: true });
    if (this.data.newPassword !== this.data.confirmation) return this.setData({ message: "两次输入的新密码不一致", error: true });
    this.setData({ busy: true, message: "正在验证并修改密码…", error: false });
    try {
      await completePasswordReset(this.data.code, this.data.newPassword);
      this.setData({ newPassword: "", confirmation: "", message: "密码已修改，请使用新密码登录", error: false });
      setTimeout(() => wx.reLaunch({ url: "/pages/login/index" }), 900);
    } catch (error) {
      this.setData({ newPassword: "", confirmation: "", message: error.message || "密码修改失败，请检查验证码或联系总部", error: true });
    } finally { this.setData({ busy: false }); }
  },
  backToLogin() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/login/index" });
  }
});

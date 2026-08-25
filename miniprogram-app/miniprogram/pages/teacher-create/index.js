const { callTeacherCreate } = require("../../services/api");
const { requireSession } = require("../../services/session");

const PENDING_KEY = "lusizhuoerMiniTeacherCreatePendingV1";
function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function validPhone(value) { return /^1[3-9]\d{9}$/.test(String(value || "").replace(/\D/g, "")); }
function validPassword(value) {
  const password = String(value || "");
  const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(password)).length;
  return password.length >= 8 && password.length <= 32 && /^[A-Za-z0-9]/.test(password) && groups >= 3;
}
function requestId() { return `teacher_create_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 64); }
function completed(result) {
  const proof = result && result.proof || {};
  const status = (...values) => text(values.find((value) => text(value))).toUpperCase();
  return Boolean(result && result.ok === true && result.completed === true && proof.complete === true
    && status(proof.teacherStatus, proof.teacher_status) === "ACTIVE"
    && status(proof.accountStatus, proof.account_status) === "ACTIVE"
    && status(proof.authStatus, proof.auth_status) === "ACTIVE"
    && text(result.uid || proof.uid) && text(result.teacherId || proof.teacherId || proof.teacher_id));
}

Page({
  data: { form: { name: "", phone: "", password: "" }, submitting: false, locked: false, message: "", error: false },
  onLoad() {
    if (!requireSession(["hq"])) return;
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    const pending = wx.getStorageSync(PENDING_KEY);
    if (pending && pending.requestId) this.setData({ locked: true, message: "上一笔老师创建结果仍待确认，请先返回老师管理查询，禁止重复提交。", error: true });
  },
  input(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  back() { if (!this.data.submitting) wx.navigateBack(); },
  async submit() {
    if (this.data.submitting || this.data.locked) return;
    const staffName = text(this.data.form.name);
    const phone = String(this.data.form.phone || "").replace(/\D/g, "");
    const initialPassword = String(this.data.form.password || "");
    if (!staffName || !validPhone(phone) || !validPassword(initialPassword)) {
      this.setData({ message: "请完整填写姓名、有效手机号和符合规则的初始密码。", error: true });
      return;
    }
    const clientRequestId = requestId();
    wx.setStorageSync(PENDING_KEY, { requestId: clientRequestId, createdAt: Date.now() });
    this.setData({ submitting: true, message: "正在创建登录账号和老师主档，请勿重复提交…", error: false });
    try {
      const result = await callTeacherCreate({ staffName, phone, initialPassword, clientRequestId });
      if (!completed(result)) throw new Error("服务端未返回完整的账号与老师主档激活证明，不能显示创建成功。");
      wx.removeStorageSync(PENDING_KEY);
      this.setData({ message: "老师账号和主档均已创建并激活。", error: false });
      wx.redirectTo({ url: "/pages/hq-directory/index?type=teacher" });
    } catch (error) {
      const signature = `${error.code || ""} ${error.message || ""}`.toUpperCase();
      const uncertain = error.submissionUncertain === true || error.transportUncertain === true
        || signature.includes("CLIENT_REQUEST_TIMEOUT") || signature.includes("CLEANUP_INCOMPLETE");
      if (!uncertain) wx.removeStorageSync(PENDING_KEY);
      this.setData({ locked: uncertain, message: uncertain ? "创建结果暂时无法确认，请先返回老师管理查询，禁止重复提交。" : error.message || "老师创建失败", error: true });
    } finally { this.setData({ submitting: false }); }
  }
});

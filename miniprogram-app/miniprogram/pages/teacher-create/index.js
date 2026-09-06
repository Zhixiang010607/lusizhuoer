const { callTeacherCreate } = require("../../services/api");
const { requireSession } = require("../../services/session");

const PENDING_KEY = "lusizhuoerMiniTeacherCreatePendingV1";
function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function validPhone(value) { return /^1[3-9]\d{9}$/.test(String(value || "").replace(/\D/g, "")); }
function passwordProblem(value) {
  const password = String(value || "");
  if (!password) return "请输入初始登录密码。";
  if (password.length < 8) return `密码长度不足：当前 ${password.length} 位，至少需要 8 位。`;
  if (password.length > 32) return "密码不能超过 32 位。";
  if (!/^[A-Za-z0-9]/.test(password)) return "密码首位必须是英文字母或数字，不能以特殊字符或空格开头。";
  const categories = [[/[A-Z]/, "大写字母"], [/[a-z]/, "小写字母"], [/\d/, "数字"], [/[^A-Za-z\d]/, "特殊字符"]];
  const included = categories.filter(([rule]) => rule.test(password));
  if (included.length < 3) {
    const missing = categories.filter(([rule]) => !rule.test(password)).map(([, label]) => label);
    return `密码目前包含 ${included.length} 类字符，还需从${missing.join("、")}中补充至少 ${3 - included.length} 类。`;
  }
  return "";
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
  data: { form: { name: "", phone: "", password: "" }, passwordVisible: false, validationField: "", submitting: false, locked: false, message: "", error: false },
  onLoad() {
    if (!requireSession(["hq"])) return;
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    const pending = wx.getStorageSync(PENDING_KEY);
    if (pending && pending.requestId) this.setData({ locked: true, message: "上一笔老师创建结果仍待确认，请先返回老师管理查询，禁止重复提交。", error: true });
  },
  input(event) {
    if (this.data.submitting || this.data.locked) return;
    const field = event.currentTarget.dataset.field;
    if (!["name", "phone", "password"].includes(field)) return;
    const changes = { [`form.${field}`]: event.detail.value };
    if (this.data.validationField === field) Object.assign(changes, { validationField: "", message: "", error: false });
    this.setData(changes);
  },
  togglePassword() {
    if (!this.data.submitting && !this.data.locked) this.setData({ passwordVisible: !this.data.passwordVisible });
  },
  back() { if (!this.data.submitting) wx.navigateBack(); },
  async submit() {
    if (this.data.submitting || this.data.locked) return;
    const staffName = text(this.data.form.name);
    const phone = String(this.data.form.phone || "").replace(/\D/g, "");
    const initialPassword = String(this.data.form.password || "");
    const passwordError = passwordProblem(initialPassword);
    const validation = !staffName ? ["name", "请输入老师姓名。"]
      : !phone ? ["phone", "请输入联系电话。"]
      : !validPhone(phone) ? ["phone", "联系电话须为 11 位中国大陆手机号，请检查位数和号码。"]
      : passwordError ? ["password", passwordError] : null;
    if (validation) {
      this.setData({ validationField: validation[0], message: validation[1], error: true });
      return;
    }
    const clientRequestId = requestId();
    wx.setStorageSync(PENDING_KEY, { requestId: clientRequestId, createdAt: Date.now() });
    this.setData({ submitting: true, passwordVisible: false, validationField: "", message: "正在创建登录账号和老师主档，请勿重复提交…", error: false });
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

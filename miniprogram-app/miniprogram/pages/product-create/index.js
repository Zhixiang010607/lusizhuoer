const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

const PENDING_KEY = "lusizhuoerMiniProductCreateV1";
function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function newRequestId() {
  return `product_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`.slice(0, 64);
}
function pendingRequestId() {
  const pending = wx.getStorageSync(PENDING_KEY);
  if (pending && pending.requestId) return String(pending.requestId);
  const requestId = newRequestId();
  wx.setStorageSync(PENDING_KEY, { requestId, createdAt: Date.now() });
  return requestId;
}

Page({
  data: { form: { name: "", type: "", description: "" }, submitting: false, message: "", error: false },
  onLoad() {
    if (!requireSession(["hq"])) return;
    wx.setNavigationBarTitle({ title: "露思卓儿" });
  },
  input(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  back() { if (!this.data.submitting) wx.navigateBack(); },
  async submit() {
    if (this.data.submitting) return;
    const productName = text(this.data.form.name);
    const productType = text(this.data.form.type);
    const description = text(this.data.form.description);
    if (!productName || !productType) {
      this.setData({ message: "请填写项目名称和项目类别", error: true });
      return;
    }
    this.setData({ submitting: true, message: "正在写入项目数据库…", error: false });
    try {
      const result = await callStaff("createProduct", {
        productName, productType, description, clientRequestId: pendingRequestId()
      });
      const productCode = text(result.product && result.product.product_code);
      if (!productCode) throw new Error("项目已写入，但服务未返回项目编号");
      wx.removeStorageSync(PENDING_KEY);
      wx.redirectTo({ url: `/pages/product-detail/index?productRef=${encodeURIComponent(productCode)}&created=1` });
    } catch (error) {
      if (error.code === "IDEMPOTENCY_CONFLICT") {
        wx.removeStorageSync(PENDING_KEY);
        this.setData({ message: "创建内容已经改变，请再次点击“创建项目”。", error: true });
      } else {
        this.setData({ message: error.message || "项目创建失败，请稍后重试", error: true });
      }
    } finally { this.setData({ submitting: false }); }
  }
});

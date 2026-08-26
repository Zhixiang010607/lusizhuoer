const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

const PENDING_KEY = "lusizhuoerMiniRetailProductCreateV1";
const CREATED_KEY = "lusizhuoerMiniRetailProductCreatedV1";
function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function newRequestId() {
  return `retail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`.slice(0, 64);
}
function pendingRequestId() {
  const pending = wx.getStorageSync(PENDING_KEY);
  if (pending && pending.requestId) return text(pending.requestId);
  const requestId = newRequestId();
  wx.setStorageSync(PENDING_KEY, { requestId, createdAt: Date.now() });
  return requestId;
}

Page({
  data: { productName: "", submitting: false, message: "", error: false },
  onLoad() {
    if (!requireSession(["hq"])) return;
    wx.setNavigationBarTitle({ title: "露思卓儿" });
  },
  inputName(event) { this.setData({ productName: event.detail.value }); },
  back() { if (!this.data.submitting) wx.navigateBack(); },
  async submit() {
    if (this.data.submitting) return;
    const productName = text(this.data.productName);
    if (!productName) {
      this.setData({ message: "请填写产品名称。", error: true });
      return;
    }
    this.setData({ submitting: true, message: "正在写入产品数据库…", error: false });
    try {
      const result = await callStaff("createRetailProduct", {
        productName,
        clientRequestId: pendingRequestId()
      });
      const productCode = text(result.product && result.product.product_code);
      if (!productCode) throw new Error("产品已写入，但数据库没有返回产品编号");
      wx.removeStorageSync(PENDING_KEY);
      wx.setStorageSync(CREATED_KEY, { code: productCode, createdAt: Date.now() });
      if (getCurrentPages().length > 1) wx.navigateBack();
      else wx.redirectTo({ url: "/pages/retail-product-management/index" });
    } catch (error) {
      if (error.code === "IDEMPOTENCY_CONFLICT") {
        wx.removeStorageSync(PENDING_KEY);
        this.setData({ message: "创建内容已经改变，请再次点击“创建产品”。", error: true });
      } else {
        this.setData({ message: error.message || "产品创建失败，请稍后重试", error: true });
      }
    } finally {
      this.setData({ submitting: false });
    }
  }
});

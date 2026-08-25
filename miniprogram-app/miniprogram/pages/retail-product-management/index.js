const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

const PENDING_KEY = "lusizhuoerMiniRetailProductCreateV1";
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
function productView(item) {
  const archived = text(item.product_status).toUpperCase() === "ARCHIVED";
  return {
    id: text(item.id), ref: text(item.product_code) || text(item.id),
    code: text(item.product_code), name: text(item.product_name) || "未命名产品",
    archived, status: archived ? "封存" : "活跃"
  };
}
function confirmModal(options) {
  return new Promise((resolve) => wx.showModal({
    ...options,
    success: (result) => resolve(Boolean(result.confirm)),
    fail: () => resolve(false)
  }));
}

Page({
  data: {
    loading: true, submitting: false, mutatingRef: "", productName: "",
    products: [], message: "", error: false
  },
  onLoad() {
    if (!requireSession(["hq"])) return;
    this._unloaded = false;
    wx.setNavigationBarTitle({ title: "露思卓儿" });
  },
  onShow() {
    if (!requireSession(["hq"])) return;
    this.load();
  },
  onUnload() {
    this._unloaded = true;
    this._requestEpoch = (this._requestEpoch || 0) + 1;
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  inputName(event) { this.setData({ productName: event.detail.value }); },
  async load(options = {}) {
    if (this._unloaded) return;
    const epoch = (this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    this.setData({ loading: true, ...(options.keepMessage ? {} : { message: "", error: false }) });
    try {
      const result = await callStaff("listRetailProducts");
      if (this._unloaded || epoch !== this._requestEpoch) return;
      this.setData({ products: (result.products || []).map(productView) });
    } catch (error) {
      if (this._unloaded || epoch !== this._requestEpoch) return;
      this.setData({ products: [], message: error.message || "产品数据库读取失败，请下拉重试", error: true });
    } finally {
      if (!this._unloaded && epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },
  async createProduct() {
    if (this.data.submitting) return;
    const productName = text(this.data.productName);
    if (!productName) {
      this.setData({ message: "请填写产品名称。", error: true });
      return;
    }
    this.setData({ submitting: true, message: "正在新增产品…", error: false });
    try {
      const result = await callStaff("createRetailProduct", {
        productName,
        clientRequestId: pendingRequestId()
      });
      const productCode = text(result.product && result.product.product_code);
      if (!productCode) throw new Error("产品已写入，但数据库没有返回产品编号");
      wx.removeStorageSync(PENDING_KEY);
      this.setData({ productName: "", message: `产品 ${productCode} 已新增。`, error: false });
      await this.load({ keepMessage: true });
    } catch (error) {
      if (error.code === "IDEMPOTENCY_CONFLICT") wx.removeStorageSync(PENDING_KEY);
      this.setData({ message: error.message || "产品新增失败，请稍后重试", error: true });
    } finally {
      this.setData({ submitting: false });
    }
  },
  async toggleStatus(event) {
    const productRef = text(event.currentTarget.dataset.ref);
    const product = this.data.products.find((item) => item.ref === productRef);
    if (!product || this.data.mutatingRef) return;
    const next = product.archived ? "ACTIVE" : "ARCHIVED";
    const action = product.archived ? "重新激活" : "封存";
    const confirmed = await confirmModal({
      title: `${action}产品`,
      content: `确认${action}“${product.name}”（${product.code}）？`,
      confirmText: product.archived ? "激活" : "封存"
    });
    if (!confirmed) return;
    this.setData({ mutatingRef: productRef, message: `正在${action}产品…`, error: false });
    try {
      await callStaff("setRetailProductStatus", { productRef, status: next });
      this.setData({ message: `产品已${product.archived ? "重新激活" : "封存"}。`, error: false });
      await this.load({ keepMessage: true });
    } catch (error) {
      this.setData({ message: error.message || `产品${action}失败`, error: true });
    } finally {
      this.setData({ mutatingRef: "" });
    }
  }
});

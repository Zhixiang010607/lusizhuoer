const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function truthy(value) { return [true, "true", "t", 1, "1"].includes(value); }
function productView(item) {
  const status = text(item.product_status).toUpperCase() === "ARCHIVED" ? "封存" : "活跃";
  return {
    id: text(item.id), ref: text(item.product_code) || text(item.id), code: text(item.product_code),
    name: text(item.product_name) || "未命名产品", type: text(item.product_type) || "未分类", status,
    templateConfigured: truthy(item.receipt_logo_configured)
      && truthy(item.verification_instructions_configured)
      && truthy(item.recharge_instructions_configured)
  };
}

Page({
  data: { loading: true, products: [], message: "", error: false },
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
  async load() {
    if (this._unloaded) return;
    const epoch = (this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const request = Object.freeze({ epoch });
    this.setData({ loading: true, message: "", error: false });
    try {
      const result = await callStaff("listProducts");
      if (this._unloaded || request.epoch !== this._requestEpoch) return;
      this.setData({ products: (result.products || []).map(productView) });
    } catch (error) {
      if (this._unloaded || request.epoch !== this._requestEpoch) return;
      this.setData({ products: [], message: error.message || "产品数据库读取失败，请下拉重试", error: true });
    } finally {
      if (!this._unloaded && request.epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },
  createProduct() { wx.navigateTo({ url: "/pages/product-create/index" }); },
  openProduct(event) {
    const ref = String(event.currentTarget.dataset.ref || "");
    if (ref) wx.navigateTo({ url: `/pages/product-detail/index?productRef=${encodeURIComponent(ref)}` });
  }
});

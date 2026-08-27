const { callFace, callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");

const PAGE_SIZE = 20;
const EMPTY_SUMMARY = Object.freeze({ total: 0, pending: 0, approved: 0, rejected: 0 });

function labels(options) { return options.map((item) => item.label); }
function values(options) { return options.map((item) => item.value); }
function dashboardFilters(options, typeOptions) {
  const drill = String(options.drill || "").toLowerCase();
  const startDate = String(options.startDate || "");
  const endDate = String(options.endDate || "");
  const customRange = /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && startDate <= endDate;
  const targetType = ({ recharge: "NEW", refund: "REFUND", verification: "NORMAL", experience: "EXPERIENCE" })[drill] || "ALL";
  return {
    typeIndex: Math.max(0, typeOptions.findIndex((item) => item.value === targetType)),
    timeIndex: customRange ? query.TIME_OPTIONS.findIndex((item) => item.value === "CUSTOM") : 0,
    startDate: customRange ? startDate : "", endDate: customRange ? endDate : "", customRange
  };
}

Page({
  data: {
    session: {}, recordType: "RECHARGE", noun: "充值", loading: false, message: "", error: false,
    mode: "browse", records: [], summary: { ...EMPTY_SUMMARY }, tableScrollLeft: 0,
    page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1, pageJump: "1",
    stores: [], storeLabels: ["全部门店"], storeIndex: 0,
    products: [], productLabels: ["全部项目"], productIndex: 0,
    statusLabels: labels(query.STATUS_OPTIONS), statusValues: values(query.STATUS_OPTIONS), statusIndex: 0,
    typeLabels: labels(query.RECHARGE_TYPES), typeValues: values(query.RECHARGE_TYPES), typeIndex: 0,
    timeLabels: labels(query.TIME_OPTIONS), timeValues: values(query.TIME_OPTIONS), timeIndex: 0,
    startDate: "", endDate: "", customRange: false, today: query.businessToday(),
    customerName: "", birthDate: ""
  },

  async onLoad(options) {
    const requestedType = String(options.type || "recharge").toLowerCase();
    const recordType = requestedType === "verification"
      ? "VERIFICATION"
      : requestedType === "product"
        ? "PRODUCT_PURCHASE"
        : "RECHARGE";
    const session = requireSession(["hq", "store"]);
    if (!session) return;
    if (recordType === "PRODUCT_PURCHASE" && session.role !== "hq") {
      wx.reLaunch({ url: "/pages/home/index" });
      return;
    }
    const typeOptions = recordType === "VERIFICATION" ? query.VERIFICATION_TYPES : query.RECHARGE_TYPES;
    const entryFilters = dashboardFilters(options, typeOptions);
    this.setData({
      session, recordType, noun: recordType === "VERIFICATION" ? "核销" : recordType === "PRODUCT_PURCHASE" ? "产品" : "充值",
      typeLabels: labels(typeOptions), typeValues: values(typeOptions), ...entryFilters
    });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    if (session.role === "hq") await this.loadStores();
    await this.load(1);
  },

  onPullDownRefresh() { this.load(1).finally(() => wx.stopPullDownRefresh()); },
  onUnload() {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this._scrollResetEpoch = Number(this._scrollResetEpoch || 0) + 1;
  },

  resetTableScroll() {
    const epoch = Number(this._scrollResetEpoch || 0) + 1;
    this._scrollResetEpoch = epoch;
    this.setData({ tableScrollLeft: 1 }, () => {
      if (epoch === this._scrollResetEpoch) this.setData({ tableScrollLeft: 0 });
    });
  },

  async loadStores() {
    try {
      const result = await callStaff("listStores");
      const stores = (result.stores || []).map((store) => ({
        id: String(store.id || store.store_id || ""),
        label: [store.store_name || store.storeName || "未命名门店", store.store_code || store.storeCode || ""].filter(Boolean).join(" · ")
      })).filter((store) => store.id);
      this.setData({ stores, storeLabels: ["全部门店", ...stores.map((store) => store.label)] });
    } catch (error) {
      this.setData({ message: error.message || "门店范围读取失败", error: true });
    }
  },

  buildPayload(page) {
    const payload = {
      recordType: this.data.recordType,
      mode: this.data.mode,
      page,
      pageSize: PAGE_SIZE
    };
    if (this.data.session.role === "hq" && this.data.storeIndex > 0) payload.storeId = this.data.stores[this.data.storeIndex - 1]?.id || "";
    if (this.data.mode === "manual") {
      payload.customerName = String(this.data.customerName || "").trim();
      payload.birthDate = this.data.birthDate;
      return payload;
    }
    payload.productId = this.data.productIndex > 0 ? this.data.products[this.data.productIndex - 1]?.productId || "ALL" : "ALL";
    payload.statusCategory = this.data.statusValues[this.data.statusIndex] || "ALL";
    if (this.data.recordType === "VERIFICATION") payload.verificationType = this.data.typeValues[this.data.typeIndex] || "ALL";
    else if (this.data.recordType === "RECHARGE") payload.rechargeType = this.data.typeValues[this.data.typeIndex] || "ALL";
    payload.startDate = this.data.startDate;
    payload.endDate = this.data.endDate;
    return payload;
  },

  async requestRecords(payload) {
    if (this.data.recordType !== "PRODUCT_PURCHASE") return callFace("queryStoreBusinessRecords", payload);
    return callStaff("listRetailProductPurchaseReviews", {
      storeId: payload.storeId || "",
      retailProductId: payload.productId && payload.productId !== "ALL" ? payload.productId : "",
      status: payload.statusCategory && payload.statusCategory !== "ALL" ? payload.statusCategory : "",
      customerName: payload.customerName || "",
      birthDate: payload.birthDate || "",
      startDate: payload.startDate || "",
      endDate: payload.endDate || "",
      limit: payload.pageSize,
      pageNumber: payload.page
    });
  },

  async load(page = 1) {
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const payload = this.buildPayload(page);
    const recordType = this.data.recordType;
    const noun = this.data.noun;
    this.setData({ loading: true, message: "", error: false, tableScrollLeft: 0 });
    try {
      const result = await this.requestRecords(payload);
      if (epoch !== this._requestEpoch) return;
      const products = (result.products || []).map((product) => ({
        productId: String(product.productId || product.retail_product_id || product.id || ""),
        label: [
          product.productName || product.product_name || "未命名产品",
          product.productCode || product.product_code || "",
          String(product.productStatus || product.product_status || "").toUpperCase() === "ARCHIVED" ? "（已封存）" : ""
        ].filter(Boolean).join(" · ")
      }));
      const selectedProductId = this.data.productIndex > 0 ? this.data.products[this.data.productIndex - 1]?.productId : "";
      const nextProductIndex = selectedProductId ? Math.max(0, products.findIndex((item) => item.productId === selectedProductId) + 1) : 0;
      const totalPages = Math.max(1, Number(result.totalPages || 1));
      const actualPage = Math.min(totalPages, Math.max(1, Number(result.page || result.pageNumber || page)));
      this.setData({
        records: (recordType === "PRODUCT_PURCHASE" ? result.orders || [] : result.records || [])
          .map((item) => recordType === "PRODUCT_PURCHASE" ? query.normalizeProductPurchaseRecord(item) : query.normalizeRecord(item, recordType)),
        summary: result.summary || { ...EMPTY_SUMMARY },
        products, productLabels: [recordType === "PRODUCT_PURCHASE" ? "全部产品" : "全部项目", ...products.map((product) => product.label)], productIndex: nextProductIndex,
        page: actualPage, pageJump: String(actualPage), total: Number(result.total || 0), totalPages
      }, () => this.resetTableScroll());
    } catch (error) {
      if (epoch !== this._requestEpoch) return;
      this.setData({
        records: [], summary: { ...EMPTY_SUMMARY }, page: 1, pageJump: "1", total: 0, totalPages: 1,
        tableScrollLeft: 0,
        message: error.message || `${noun}查询失败`, error: true
      });
    } finally {
      if (epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },

  invalidateRequest(changes) {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this.setData({ tableScrollLeft: 0, ...(changes || {}), loading: false });
  },

  setMode(event) {
    const mode = event.currentTarget.dataset.mode === "manual" ? "manual" : "browse";
    this.invalidateRequest({ mode, page: 1, pageJump: "1" });
  },
  chooseStore(event) { this.invalidateRequest({ storeIndex: Number(event.detail.value) }); },
  chooseProduct(event) { this.invalidateRequest({ productIndex: Number(event.detail.value) }); },
  chooseStatus(event) { this.invalidateRequest({ statusIndex: Number(event.detail.value) }); },
  chooseType(event) { this.invalidateRequest({ typeIndex: Number(event.detail.value) }); },
  chooseTime(event) {
    const timeIndex = Number(event.detail.value);
    const value = this.data.timeValues[timeIndex] || "ALL";
    const range = query.timeRange(value, { startDate: this.data.startDate, endDate: this.data.endDate });
    this.invalidateRequest({ timeIndex, customRange: value === "CUSTOM", startDate: range.startDate, endDate: range.endDate });
  },
  changeStart(event) { this.invalidateRequest({ startDate: event.detail.value }); },
  changeEnd(event) { this.invalidateRequest({ endDate: event.detail.value }); },
  inputCustomerName(event) { this.invalidateRequest({ customerName: event.detail.value }); },
  inputBirthDate(event) { this.invalidateRequest({ birthDate: event.detail.value }); },
  runQuery() {
    if (this.data.startDate && this.data.endDate && this.data.startDate > this.data.endDate) {
      this.setData({ message: "开始日期不能晚于结束日期", error: true }); return;
    }
    this.load(1);
  },
  resetQuery() {
    this.invalidateRequest({
      mode: "browse", storeIndex: 0, productIndex: 0, statusIndex: 0, typeIndex: 0, timeIndex: 0,
      startDate: "", endDate: "", customRange: false, customerName: "", birthDate: "", page: 1, pageJump: "1"
    });
    this.load(1);
  },
  previousPage() { if (!this.data.loading && this.data.page > 1) this.load(this.data.page - 1); },
  nextPage() { if (!this.data.loading && this.data.page < this.data.totalPages) this.load(this.data.page + 1); },
  inputPageJump(event) { this.setData({ pageJump: String(event.detail.value || "") }); },
  jumpPage() {
    const requested = Number(this.data.pageJump);
    if (!Number.isInteger(requested) || requested < 1 || requested > this.data.totalPages) {
      this.setData({ message: `请输入 1 到 ${this.data.totalPages} 的有效页码`, error: true }); return;
    }
    this.load(requested);
  },
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  },
  openRecord(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const code = String(event.currentTarget.dataset.code || "");
    const originalType = String(event.currentTarget.dataset.category || "").toUpperCase();
    if (this.data.recordType === "PRODUCT_PURCHASE") {
      if (id) wx.navigateTo({ url: `/pages/product-purchase-detail/index?recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}` });
      return;
    }
    const category = this.data.recordType === "RECHARGE"
      ? (originalType === "REFUND" ? "REFUND" : originalType === "VOID" ? "VOID" : "RECHARGE")
      : (originalType === "EXPERIENCE" ? "EXPERIENCE" : originalType === "SUPPLEMENT" ? "SUPPLEMENT" : "VERIFICATION");
    if (id) wx.navigateTo({ url: `/pages/order-detail/index?type=${this.data.recordType.toLowerCase()}&category=${category}&recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}` });
  }
});

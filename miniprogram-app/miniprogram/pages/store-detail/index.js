const { callFace, callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const dashboard = require("../../services/home-dashboard");

const PAGE_SIZE = 10;
function text(...values) { return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "").trim(); }
function archived(row = {}) { return [row.store_status, row.account_status, row.status].some((value) => text(value).toUpperCase() === "ARCHIVED"); }
function pageView(source = {}) {
  const page = dashboard.pageState(source);
  return { ...page, previousDisabled: page.page <= 1, nextDisabled: page.page >= page.totalPages };
}
function customerView(source = {}) { return { ...source, previousDisabled: source.page <= 1, nextDisabled: source.page >= source.totalPages }; }
function summaryRows(items, totals) {
  const rows = dashboard.products(items);
  if (!rows.length) return [];
  return [...rows, { productId: "total", productName: "合计", productCode: "", ...dashboard.totals(totals), total: true }];
}
function hero(store = {}) {
  return {
    id: text(store.id), name: text(store.store_name, store.storeName) || "门店", code: text(store.store_code, store.storeCode) || "—",
    account: text(store.auth_uid, store.store_code) || "未绑定登录账号", archived: archived(store), initials: "店"
  };
}
function confirm(content, confirmText) {
  return new Promise((resolve) => wx.showModal({ title: "请确认", content, confirmText, success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
}

Page({
  data: {
    storeRef: "", storeId: "", account: null, store: null, storeHero: {}, profileFacts: [], loading: true, statusLoading: false,
    message: "", error: false, rangePreset: "MONTH", rangeOptions: dashboard.RANGE_OPTIONS, rangeStart: "", rangeEnd: "", customRangeVisible: false,
    summaryRows: [], totals: { ...dashboard.EMPTY_TOTALS }, businessType: "VERIFICATION", businessTabs: dashboard.tabs({}, "VERIFICATION"),
    businessRecords: [], businessPage: pageView({}), businessLoading: false,
    activeCustomers: customerView(dashboard.customerGroup()), archivedCustomers: customerView(dashboard.customerGroup())
  },
  onLoad(options) {
    if (!requireSession(["hq"])) return;
    this.setData({ storeRef: decodeURIComponent(options.storeRef || "") });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack(); },
  async resolveStore() {
    const result = await callStaff("listStores");
    const account = (result.stores || []).find((item) => [item.auth_uid, item.id, item.store_code].map(text).includes(this.data.storeRef));
    if (!account) throw new Error("未找到该门店账号，或门店尚未绑定有效认证身份");
    const storeId = text(account.id);
    if (!/^\d+$/.test(storeId)) throw new Error("所选门店缺少有效数据库编号");
    this.setData({ account, storeId });
    return storeId;
  },
  rangeData() {
    const range = dashboard.scopedRange(this.data.rangePreset, { startDate: this.data.rangeStart, endDate: this.data.rangeEnd });
    if (range.startDate && range.endDate && dashboard.rangeDays(range.startDate, range.endDate) > 366) throw new Error("单次最多统计 366 天");
    return range;
  },
  async load() {
    if (this._loading) return;
    this._loading = true;
    this.setData({ loading: true, message: "", error: false });
    try {
      const storeId = this.data.storeId || await this.resolveStore();
      const range = this.rangeData();
      this.setData({ rangeStart: range.startDate, rangeEnd: range.endDate });
      const config = dashboard.TYPE_CONFIG[this.data.businessType];
      const rangePayload = dashboard.payload(range.startDate, range.endDate);
      const [storeResult, analyticsResult, recordsResult] = await Promise.all([
        callFace("getStoreDashboard", { storeId, activeCustomerPage: this.data.activeCustomers.page, archivedCustomerPage: this.data.archivedCustomers.page }),
        callFace("getStoreBusinessAnalytics", { storeId, ...rangePayload, allTime: !range.startDate }),
        callFace("queryStoreBusinessRecords", { storeId, mode: "browse", statusCategory: "APPROVED", recordType: config.recordType, verificationType: config.verificationType, rechargeType: config.rechargeType, page: this.data.businessPage.page, pageSize: PAGE_SIZE, ...rangePayload })
      ]);
      const store = storeResult.store || {};
      const groups = dashboard.storeCustomerGroups(store);
      const totals = dashboard.totals(analyticsResult.totals);
      this.setData({
        store, storeHero: hero({ ...this.data.account, ...store }), profileFacts: dashboard.storeFacts(store),
        activeCustomers: customerView(groups.active), archivedCustomers: customerView(groups.archived), totals,
        summaryRows: summaryRows(analyticsResult.products, totals), businessTabs: dashboard.tabs(totals, this.data.businessType),
        businessRecords: dashboard.records(recordsResult.records, this.data.businessType), businessPage: pageView(recordsResult)
      });
    } catch (error) { this.setData({ message: error.message || "门店主页读取失败", error: true }); }
    finally { this._loading = false; this.setData({ loading: false }); }
  },
  chooseRange(event) {
    const rangePreset = String(event.currentTarget.dataset.value || "MONTH");
    const customRangeVisible = rangePreset === "CUSTOM";
    this.setData({ rangePreset, customRangeVisible, businessPage: pageView({}) });
    if (!customRangeVisible) this.reloadAnalytics();
  },
  chooseStart(event) { this.setData({ rangeStart: event.detail.value }); },
  chooseEnd(event) { this.setData({ rangeEnd: event.detail.value }); },
  applyCustomRange() { this.reloadAnalytics(); },
  async reloadAnalytics() {
    if (this.data.businessLoading || !this.data.storeId) return;
    this.setData({ businessLoading: true, message: "", error: false });
    try {
      const range = this.rangeData();
      this.setData({ rangeStart: range.startDate, rangeEnd: range.endDate });
      const config = dashboard.TYPE_CONFIG[this.data.businessType];
      const rangePayload = dashboard.payload(range.startDate, range.endDate);
      const [analytics, records] = await Promise.all([
        callFace("getStoreBusinessAnalytics", { storeId: this.data.storeId, ...rangePayload, allTime: !range.startDate }),
        callFace("queryStoreBusinessRecords", { storeId: this.data.storeId, mode: "browse", statusCategory: "APPROVED", recordType: config.recordType, verificationType: config.verificationType, rechargeType: config.rechargeType, page: 1, pageSize: PAGE_SIZE, ...rangePayload })
      ]);
      const totals = dashboard.totals(analytics.totals);
      this.setData({ totals, summaryRows: summaryRows(analytics.products, totals), businessTabs: dashboard.tabs(totals, this.data.businessType), businessRecords: dashboard.records(records.records, this.data.businessType), businessPage: pageView(records) });
    } catch (error) { this.setData({ message: error.message || "业务统计读取失败", error: true }); }
    finally { this.setData({ businessLoading: false }); }
  },
  chooseBusiness(event) {
    const businessType = String(event.currentTarget.dataset.type || "VERIFICATION");
    this.setData({ businessType, businessTabs: dashboard.tabs(this.data.totals, businessType), businessPage: pageView({}) });
    this.loadBusinessPage(1);
  },
  async loadBusinessPage(page) {
    if (this.data.businessLoading || !this.data.storeId) return;
    this.setData({ businessLoading: true, message: "", error: false });
    try {
      const range = this.rangeData();
      const config = dashboard.TYPE_CONFIG[this.data.businessType];
      const result = await callFace("queryStoreBusinessRecords", { storeId: this.data.storeId, mode: "browse", statusCategory: "APPROVED", recordType: config.recordType, verificationType: config.verificationType, rechargeType: config.rechargeType, page, pageSize: PAGE_SIZE, ...dashboard.payload(range.startDate, range.endDate) });
      this.setData({ businessRecords: dashboard.records(result.records, this.data.businessType), businessPage: pageView(result) });
    } catch (error) { this.setData({ message: error.message || "业务明细读取失败", error: true }); }
    finally { this.setData({ businessLoading: false }); }
  },
  previousBusiness() { this.loadBusinessPage(this.data.businessPage.page - 1); },
  nextBusiness() { this.loadBusinessPage(this.data.businessPage.page + 1); },
  async loadCustomerPage(status, page) {
    try {
      const activePage = status === "ACTIVE" ? page : this.data.activeCustomers.page;
      const archivedPage = status === "ARCHIVED" ? page : this.data.archivedCustomers.page;
      const result = await callFace("getStoreDashboard", { storeId: this.data.storeId, activeCustomerPage: activePage, archivedCustomerPage: archivedPage });
      const groups = dashboard.storeCustomerGroups(result.store || {});
      this.setData({ activeCustomers: customerView(groups.active), archivedCustomers: customerView(groups.archived) });
    } catch (error) { this.setData({ message: error.message || "客户列表读取失败", error: true }); }
  },
  previousCustomer(event) { const status = event.currentTarget.dataset.status; const group = status === "ACTIVE" ? this.data.activeCustomers : this.data.archivedCustomers; this.loadCustomerPage(status, group.page - 1); },
  nextCustomer(event) { const status = event.currentTarget.dataset.status; const group = status === "ACTIVE" ? this.data.activeCustomers : this.data.archivedCustomers; this.loadCustomerPage(status, group.page + 1); },
  openCustomer(event) { const code = String(event.currentTarget.dataset.code || ""); if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` }); },
  openOrder(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!id) return;
    const category = this.data.businessType;
    const baseType = ["RECHARGE", "REFUND"].includes(category) ? "recharge" : "verification";
    wx.navigateTo({ url: `/pages/order-detail/index?type=${baseType}&category=${category}&recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(event.currentTarget.dataset.code || "")}` });
  },
  async toggleStatus() {
    if (this.data.statusLoading || !this.data.storeId || !this.data.store) return;
    const next = this.data.storeHero.archived ? "ACTIVE" : "ARCHIVED";
    const action = next === "ARCHIVED" ? "封存" : "激活";
    const note = next === "ARCHIVED" ? "门店账号将停止登录和业务办理，历史业务与统计完整保留。" : "关联门店账号将恢复登录。";
    if (!await confirm(`确认${action}门店“${this.data.storeHero.name}”？${note}`, action)) return;
    this.setData({ statusLoading: true, message: `正在${action}门店并同步登录账号…`, error: false });
    try {
      const result = await callStaff("setMasterStatus", { storeId: this.data.storeId, status: next });
      if (text(result.status).toUpperCase() !== next) throw new Error("门店状态服务没有确认保存结果");
      const verify = await callFace("getStoreDashboard", { storeId: this.data.storeId, activeCustomerPage: this.data.activeCustomers.page, archivedCustomerPage: this.data.archivedCustomers.page });
      const store = verify.store || {};
      if (archived(store) !== (next === "ARCHIVED")) throw new Error("数据库回读状态与本次操作不一致");
      this.setData({ store, storeHero: hero({ ...this.data.account, ...store }), profileFacts: dashboard.storeFacts(store), message: `门店已${action}。`, error: false });
    } catch (error) { this.setData({ message: error.message || `门店${action}失败`, error: true }); }
    finally { this.setData({ statusLoading: false }); }
  }
});

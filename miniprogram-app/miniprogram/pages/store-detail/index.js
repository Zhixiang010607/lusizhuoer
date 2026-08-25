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
const REQUEST_EPOCH_KEYS = Object.freeze([
  "_loadRequestEpoch", "_profileRequestEpoch", "_analyticsRequestEpoch", "_businessRequestEpoch",
  "_activeCustomerRequestEpoch", "_archivedCustomerRequestEpoch", "_statusRequestEpoch"
]);
function bump(page, key) { const epoch = (page[key] || 0) + 1; page[key] = epoch; return epoch; }
function current(page, key, epoch) { return !page._unloaded && page[key] === epoch; }
function emptyCustomers() { return customerView(dashboard.customerGroup()); }
function emptyBusinessPage() { return pageView({}); }

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
    this._unloaded = false;
    this.setData({ storeRef: decodeURIComponent(options.storeRef || "") });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    this.load();
  },
  onUnload() {
    this._unloaded = true;
    REQUEST_EPOCH_KEYS.forEach((key) => bump(this, key));
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack(); },
  async resolveStore(storeRef) {
    const result = await callStaff("listStores");
    const account = (result.stores || []).find((item) => [item.auth_uid, item.id, item.store_code].map(text).includes(storeRef));
    if (!account) throw new Error("未找到该门店账号，或门店尚未绑定有效认证身份");
    const storeId = text(account.id);
    if (!/^\d+$/.test(storeId)) throw new Error("所选门店缺少有效数据库编号");
    return Object.freeze({ account: Object.freeze({ ...account }), storeId });
  },
  rangeData(source = this.data) {
    const range = dashboard.scopedRange(source.rangePreset, { startDate: source.rangeStart, endDate: source.rangeEnd });
    if (range.startDate && range.endDate && dashboard.rangeDays(range.startDate, range.endDate) > 366) throw new Error("单次最多统计 366 天");
    return range;
  },
  async load() {
    if (this._unloaded) return;
    const request = Object.freeze({
      loadEpoch: bump(this, "_loadRequestEpoch"),
      profileEpoch: bump(this, "_profileRequestEpoch"),
      analyticsEpoch: bump(this, "_analyticsRequestEpoch"),
      businessEpoch: bump(this, "_businessRequestEpoch"),
      activeCustomerEpoch: bump(this, "_activeCustomerRequestEpoch"),
      archivedCustomerEpoch: bump(this, "_archivedCustomerRequestEpoch"),
      storeRef: text(this.data.storeRef), storeId: text(this.data.storeId),
      account: this.data.account ? Object.freeze({ ...this.data.account }) : null,
      rangePreset: this.data.rangePreset, rangeStart: this.data.rangeStart, rangeEnd: this.data.rangeEnd,
      businessType: this.data.businessType, businessPage: this.data.businessPage.page,
      activeCustomerPage: this.data.activeCustomers.page, archivedCustomerPage: this.data.archivedCustomers.page
    });
    this.setData({ loading: true, message: "", error: false });
    try {
      const resolved = request.storeId
        ? Object.freeze({ storeId: request.storeId, account: request.account })
        : await this.resolveStore(request.storeRef);
      if (!current(this, "_loadRequestEpoch", request.loadEpoch)) return;
      const storeId = resolved.storeId;
      this.setData({ account: resolved.account, storeId });
      const range = this.rangeData(request);
      this.setData({ rangeStart: range.startDate, rangeEnd: range.endDate });
      const config = dashboard.TYPE_CONFIG[request.businessType];
      const rangePayload = dashboard.payload(range.startDate, range.endDate);
      const [storeRead, analyticsRead, recordsRead] = await Promise.allSettled([
        callFace("getStoreDashboard", Object.freeze({ storeId, activeCustomerPage: request.activeCustomerPage, archivedCustomerPage: request.archivedCustomerPage })),
        callFace("getStoreBusinessAnalytics", Object.freeze({ storeId, ...rangePayload, allTime: !range.startDate })),
        callFace("queryStoreBusinessRecords", Object.freeze({ storeId, mode: "browse", statusCategory: "APPROVED", recordType: config.recordType, verificationType: config.verificationType, rechargeType: config.rechargeType, page: request.businessPage, pageSize: PAGE_SIZE, ...rangePayload }))
      ]);
      if (!current(this, "_loadRequestEpoch", request.loadEpoch)) return;
      const patch = {};
      let failureMessage = "";
      const profileCurrent = current(this, "_profileRequestEpoch", request.profileEpoch);
      const activeCustomersCurrent = current(this, "_activeCustomerRequestEpoch", request.activeCustomerEpoch);
      const archivedCustomersCurrent = current(this, "_archivedCustomerRequestEpoch", request.archivedCustomerEpoch);
      if (profileCurrent || activeCustomersCurrent || archivedCustomersCurrent) {
        if (storeRead.status === "fulfilled") {
          const store = storeRead.value.store || {};
          const groups = dashboard.storeCustomerGroups(store);
          if (profileCurrent) Object.assign(patch, { store, storeHero: hero({ ...(resolved.account || {}), ...store }), profileFacts: dashboard.storeFacts(store) });
          if (activeCustomersCurrent) patch.activeCustomers = customerView(groups.active);
          if (archivedCustomersCurrent) patch.archivedCustomers = customerView(groups.archived);
        } else {
          if (profileCurrent) Object.assign(patch, { store: null, storeHero: {}, profileFacts: [] });
          if (activeCustomersCurrent) patch.activeCustomers = emptyCustomers();
          if (archivedCustomersCurrent) patch.archivedCustomers = emptyCustomers();
          failureMessage = storeRead.reason && storeRead.reason.message || "门店资料与客户列表读取失败";
        }
      }
      if (current(this, "_analyticsRequestEpoch", request.analyticsEpoch)) {
        if (analyticsRead.status === "fulfilled") {
          const totals = dashboard.totals(analyticsRead.value.totals);
          Object.assign(patch, { totals, summaryRows: summaryRows(analyticsRead.value.products, totals), businessTabs: dashboard.tabs(totals, this.data.businessType) });
        } else {
          Object.assign(patch, { totals: { ...dashboard.EMPTY_TOTALS }, summaryRows: [], businessTabs: dashboard.tabs(dashboard.EMPTY_TOTALS, this.data.businessType) });
          if (!failureMessage) failureMessage = analyticsRead.reason && analyticsRead.reason.message || "业务统计读取失败";
        }
      }
      if (current(this, "_businessRequestEpoch", request.businessEpoch)) {
        if (recordsRead.status === "fulfilled") Object.assign(patch, { businessRecords: dashboard.records(recordsRead.value.records, request.businessType), businessPage: pageView(recordsRead.value) });
        else {
          Object.assign(patch, { businessRecords: [], businessPage: emptyBusinessPage() });
          if (!failureMessage) failureMessage = recordsRead.reason && recordsRead.reason.message || "业务明细读取失败";
        }
      }
      if (failureMessage) Object.assign(patch, { message: failureMessage, error: true });
      if (Object.keys(patch).length) this.setData(patch);
    } catch (error) {
      if (!current(this, "_loadRequestEpoch", request.loadEpoch)) return;
      const patch = { message: error.message || "门店主页读取失败", error: true };
      if (current(this, "_profileRequestEpoch", request.profileEpoch)) Object.assign(patch, { store: null, storeHero: {}, profileFacts: [] });
      if (current(this, "_activeCustomerRequestEpoch", request.activeCustomerEpoch)) patch.activeCustomers = emptyCustomers();
      if (current(this, "_archivedCustomerRequestEpoch", request.archivedCustomerEpoch)) patch.archivedCustomers = emptyCustomers();
      if (current(this, "_analyticsRequestEpoch", request.analyticsEpoch)) Object.assign(patch, {
        totals: { ...dashboard.EMPTY_TOTALS }, summaryRows: [], businessTabs: dashboard.tabs(dashboard.EMPTY_TOTALS, this.data.businessType)
      });
      if (current(this, "_businessRequestEpoch", request.businessEpoch)) Object.assign(patch, { businessRecords: [], businessPage: emptyBusinessPage() });
      this.setData(patch);
    } finally {
      if (current(this, "_loadRequestEpoch", request.loadEpoch)) this.setData({ loading: false });
    }
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
    if (this._unloaded || !this.data.storeId) return;
    const request = Object.freeze({
      analyticsEpoch: bump(this, "_analyticsRequestEpoch"), businessEpoch: bump(this, "_businessRequestEpoch"),
      storeId: text(this.data.storeId), rangePreset: this.data.rangePreset, rangeStart: this.data.rangeStart, rangeEnd: this.data.rangeEnd,
      businessType: this.data.businessType
    });
    this.setData({ businessLoading: true, message: "", error: false });
    try {
      const range = this.rangeData(request);
      if (current(this, "_analyticsRequestEpoch", request.analyticsEpoch)) this.setData({ rangeStart: range.startDate, rangeEnd: range.endDate });
      const config = dashboard.TYPE_CONFIG[request.businessType];
      const rangePayload = dashboard.payload(range.startDate, range.endDate);
      const [analyticsRead, recordsRead] = await Promise.allSettled([
        callFace("getStoreBusinessAnalytics", Object.freeze({ storeId: request.storeId, ...rangePayload, allTime: !range.startDate })),
        callFace("queryStoreBusinessRecords", Object.freeze({ storeId: request.storeId, mode: "browse", statusCategory: "APPROVED", recordType: config.recordType, verificationType: config.verificationType, rechargeType: config.rechargeType, page: 1, pageSize: PAGE_SIZE, ...rangePayload }))
      ]);
      const patch = {};
      let failureMessage = "";
      if (current(this, "_analyticsRequestEpoch", request.analyticsEpoch)) {
        if (analyticsRead.status === "fulfilled") {
          const totals = dashboard.totals(analyticsRead.value.totals);
          Object.assign(patch, { totals, summaryRows: summaryRows(analyticsRead.value.products, totals), businessTabs: dashboard.tabs(totals, this.data.businessType) });
        } else {
          Object.assign(patch, { totals: { ...dashboard.EMPTY_TOTALS }, summaryRows: [], businessTabs: dashboard.tabs(dashboard.EMPTY_TOTALS, this.data.businessType) });
          failureMessage = analyticsRead.reason && analyticsRead.reason.message || "业务统计读取失败";
        }
      }
      if (current(this, "_businessRequestEpoch", request.businessEpoch)) {
        if (recordsRead.status === "fulfilled") Object.assign(patch, { businessRecords: dashboard.records(recordsRead.value.records, request.businessType), businessPage: pageView(recordsRead.value) });
        else {
          Object.assign(patch, { businessRecords: [], businessPage: emptyBusinessPage() });
          if (!failureMessage) failureMessage = recordsRead.reason && recordsRead.reason.message || "业务明细读取失败";
        }
      }
      if (failureMessage) Object.assign(patch, { message: failureMessage, error: true });
      if (Object.keys(patch).length) this.setData(patch);
    } catch (error) {
      const analyticsCurrent = current(this, "_analyticsRequestEpoch", request.analyticsEpoch);
      const businessCurrent = current(this, "_businessRequestEpoch", request.businessEpoch);
      if (!analyticsCurrent && !businessCurrent) return;
      const patch = { message: error.message || "业务统计读取失败", error: true };
      if (analyticsCurrent) Object.assign(patch, {
        totals: { ...dashboard.EMPTY_TOTALS }, summaryRows: [], businessTabs: dashboard.tabs(dashboard.EMPTY_TOTALS, this.data.businessType)
      });
      if (businessCurrent) Object.assign(patch, { businessRecords: [], businessPage: emptyBusinessPage() });
      this.setData(patch);
    } finally {
      if (current(this, "_businessRequestEpoch", request.businessEpoch)) this.setData({ businessLoading: false });
    }
  },
  chooseBusiness(event) {
    const businessType = String(event.currentTarget.dataset.type || "VERIFICATION");
    this.setData({ businessType, businessTabs: dashboard.tabs(this.data.totals, businessType), businessPage: pageView({}) });
    this.loadBusinessPage(1);
  },
  async loadBusinessPage(page) {
    if (this._unloaded || !this.data.storeId) return;
    const request = Object.freeze({
      epoch: bump(this, "_businessRequestEpoch"), storeId: text(this.data.storeId), businessType: this.data.businessType,
      rangePreset: this.data.rangePreset, rangeStart: this.data.rangeStart, rangeEnd: this.data.rangeEnd, page: Number(page)
    });
    this.setData({ businessLoading: true, message: "", error: false });
    try {
      const range = this.rangeData(request);
      const config = dashboard.TYPE_CONFIG[request.businessType];
      const payload = Object.freeze({ storeId: request.storeId, mode: "browse", statusCategory: "APPROVED", recordType: config.recordType, verificationType: config.verificationType, rechargeType: config.rechargeType, page: request.page, pageSize: PAGE_SIZE, ...dashboard.payload(range.startDate, range.endDate) });
      const result = await callFace("queryStoreBusinessRecords", payload);
      if (!current(this, "_businessRequestEpoch", request.epoch)) return;
      this.setData({ businessRecords: dashboard.records(result.records, request.businessType), businessPage: pageView(result) });
    } catch (error) {
      if (!current(this, "_businessRequestEpoch", request.epoch)) return;
      this.setData({ businessRecords: [], businessPage: emptyBusinessPage(), message: error.message || "业务明细读取失败", error: true });
    } finally {
      if (current(this, "_businessRequestEpoch", request.epoch)) this.setData({ businessLoading: false });
    }
  },
  previousBusiness() { this.loadBusinessPage(this.data.businessPage.page - 1); },
  nextBusiness() { this.loadBusinessPage(this.data.businessPage.page + 1); },
  async loadCustomerPage(status, page) {
    if (this._unloaded || !this.data.storeId || !["ACTIVE", "ARCHIVED"].includes(status)) return;
    const epochKey = status === "ACTIVE" ? "_activeCustomerRequestEpoch" : "_archivedCustomerRequestEpoch";
    const request = Object.freeze({
      epoch: bump(this, epochKey), epochKey, status, page: Number(page), storeId: text(this.data.storeId),
      activeCustomerPage: status === "ACTIVE" ? Number(page) : this.data.activeCustomers.page,
      archivedCustomerPage: status === "ARCHIVED" ? Number(page) : this.data.archivedCustomers.page
    });
    this.setData({ message: "", error: false });
    try {
      const payload = Object.freeze({ storeId: request.storeId, activeCustomerPage: request.activeCustomerPage, archivedCustomerPage: request.archivedCustomerPage });
      const result = await callFace("getStoreDashboard", payload);
      if (!current(this, request.epochKey, request.epoch)) return;
      const groups = dashboard.storeCustomerGroups(result.store || {});
      this.setData(request.status === "ACTIVE"
        ? { activeCustomers: customerView(groups.active) }
        : { archivedCustomers: customerView(groups.archived) });
    } catch (error) {
      if (!current(this, request.epochKey, request.epoch)) return;
      this.setData({ [request.status === "ACTIVE" ? "activeCustomers" : "archivedCustomers"]: emptyCustomers(), message: error.message || "客户列表读取失败", error: true });
    }
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
    if (this._unloaded) return;
    const pendingProfileEpoch = bump(this, "_profileRequestEpoch");
    const request = Object.freeze({
      epoch: bump(this, "_statusRequestEpoch"), storeId: text(this.data.storeId), next, action,
      account: this.data.account ? Object.freeze({ ...this.data.account }) : null,
      activeCustomerPage: this.data.activeCustomers.page, archivedCustomerPage: this.data.archivedCustomers.page,
      pendingProfileEpoch
    });
    let ownedProfileEpoch = request.pendingProfileEpoch;
    this.setData({ statusLoading: true, message: `正在${action}门店并同步登录账号…`, error: false });
    try {
      const result = await callStaff("setMasterStatus", Object.freeze({ storeId: request.storeId, status: request.next }));
      if (!current(this, "_statusRequestEpoch", request.epoch)) return;
      if (text(result.status).toUpperCase() !== request.next) throw new Error("门店状态服务没有确认保存结果");
      const profileEpoch = bump(this, "_profileRequestEpoch");
      ownedProfileEpoch = profileEpoch;
      const verify = await callFace("getStoreDashboard", Object.freeze({ storeId: request.storeId, activeCustomerPage: request.activeCustomerPage, archivedCustomerPage: request.archivedCustomerPage }));
      if (!current(this, "_statusRequestEpoch", request.epoch) || !current(this, "_profileRequestEpoch", profileEpoch)) return;
      const store = verify.store || {};
      if (archived(store) !== (request.next === "ARCHIVED")) throw new Error("数据库回读状态与本次操作不一致");
      this.setData({ store, storeHero: hero({ ...(request.account || {}), ...store }), profileFacts: dashboard.storeFacts(store), message: `门店已${request.action}。`, error: false });
    } catch (error) {
      if (!current(this, "_statusRequestEpoch", request.epoch) || !current(this, "_profileRequestEpoch", ownedProfileEpoch)) return;
      this.setData({ store: null, storeHero: {}, profileFacts: [], message: error.message || `门店${request.action}失败`, error: true });
    } finally {
      if (current(this, "_statusRequestEpoch", request.epoch)) this.setData({ statusLoading: false });
    }
  }
});

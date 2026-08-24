const { callFace, callStaff } = require("../../services/api");
const { requireSession, getSelectedStore, setSelectedStore, signOut } = require("../../services/session");
const dashboard = require("../../services/home-dashboard");

const ROLE_META = Object.freeze({
  hq: { title: "总部数据看板", subtitle: "真实数据库统计 · 默认显示最近 30 日" },
  store: { title: "门店全局视图", subtitle: "业务汇总与门店资料" },
  teacher: { title: "我的工作台", subtitle: "查看本人有效业务、项目汇总与体验项目剩余次数" }
});
const DIMENSIONS = Object.freeze([
  { value: "store", label: "门店" },
  { value: "teacher", label: "老师" },
  { value: "project", label: "项目" }
]);
const PAGE_SIZE = 10;
const RANKING_PAGE_SIZE = 100;

function readyRangeOptions(active) {
  return dashboard.RANGE_OPTIONS.map((item) => ({ ...item, active: item.value === active }));
}
function readyTabs(totals, active) { return dashboard.tabs(totals, active); }
function summaryRows(products, totals) {
  const rows = dashboard.products(products);
  if (!rows.length) return [];
  return [...rows, { productId: "TOTAL", productCode: "", productName: "合计", ...dashboard.totals(totals), total: true }];
}
function pageView(page) {
  const value = dashboard.pageState(page);
  return { ...value, previousDisabled: value.page <= 1, nextDisabled: value.page >= value.totalPages };
}
function quotaRows(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    monthlyAllowance: dashboard.count(item.monthlyAllowance),
    usedCount: dashboard.count(item.usedCount),
    availableCount: dashboard.count(item.availableCount)
  }));
}
function customerView(group) { return { ...group, ...pageView(group) }; }
function rejectedMessage(results, fallback) {
  const failed = results.find((item) => item.status === "rejected");
  return failed ? failed.reason?.message || fallback : "";
}

Page({
  data: {
    session: {}, roleTitle: "", roleSubtitle: "", loading: true, message: "", error: false, businessMenuOpen: false,
    stores: [], storeLabels: [], storeIndex: 0, selectedStore: null, loadingStores: false,
    rangePreset: "MONTH", rangeOptions: readyRangeOptions("MONTH"), rangeStart: "", rangeEnd: "",
    rangeLabel: "本月", customRangeVisible: false,
    profileFacts: [], storeHero: {}, experienceBalances: [], summaryRows: [],
    totals: { ...dashboard.EMPTY_TOTALS }, businessType: "VERIFICATION",
    businessTabs: readyTabs(dashboard.EMPTY_TOTALS, "VERIFICATION"), businessRecords: [],
    businessPage: pageView({}), businessLoading: false,
    activeCustomers: customerView(dashboard.customerGroup()), archivedCustomers: customerView(dashboard.customerGroup()),
    hqPeriodOptions: dashboard.HQ_PERIOD_OPTIONS, hqPeriodLabels: dashboard.HQ_PERIOD_OPTIONS.map((item) => item.label),
    hqPeriod: "LAST_30", hqPeriodIndex: 3, hqStart: "", hqEnd: "",
    hqMetrics: [], hqCharts: [], hqDimensions: DIMENSIONS,
    hqDimensionLabels: DIMENSIONS.map((item) => item.label), hqDimension: "store", hqDimensionIndex: 0,
    hqRanking: [], hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE })
  },

  onShow() {
    const session = requireSession();
    if (!session) return;
    const meta = ROLE_META[session.role] || { title: "工作台", subtitle: "" };
    this.setData({ session, roleTitle: meta.title, roleSubtitle: meta.subtitle, message: "", error: false });
    if (session.role === "teacher") this.loadTeacherHome();
    else if (session.role === "store") this.loadStoreHome();
    else this.loadHqHome();
  },

  async loadTeacherHome() {
    const range = dashboard.scopedRange(this.data.rangePreset, { startDate: this.data.rangeStart, endDate: this.data.rangeEnd });
    this.setData({ loading: true, loadingStores: true, rangeStart: range.startDate, rangeEnd: range.endDate });
    const [contextResult, workspaceResult, customersResult] = await Promise.allSettled([
      callFace("getTeacherBusinessContext"),
      callFace("getTeacherWorkspace", {
        recordType: this.data.businessType, page: this.data.businessPage.page, pageSize: PAGE_SIZE,
        includeOverview: true, ...dashboard.payload(range.startDate, range.endDate)
      }),
      callFace("getTeacherBusinessCustomers", {
        activePage: this.data.activeCustomers.page, archivedPage: this.data.archivedCustomers.page
      })
    ]);
    const changes = { loading: false, loadingStores: false };
    if (contextResult.status === "fulfilled") {
      const stores = (contextResult.value.stores || []).map((store) => ({
        id: String(store.storeId), code: String(store.storeCode || ""), name: String(store.storeName || "")
      }));
      const saved = getSelectedStore(this.data.session);
      const selected = stores.find((store) => saved && store.id === saved.id) || null;
      Object.assign(changes, {
        stores, storeLabels: stores.map((store) => `${store.name} · ${store.code || store.id}`), selectedStore: selected,
        storeIndex: Math.max(0, stores.findIndex((store) => selected && store.id === selected.id))
      });
    }
    if (workspaceResult.status === "fulfilled") {
      const value = workspaceResult.value;
      const totals = dashboard.totals(value.summary?.totals);
      Object.assign(changes, {
        profileFacts: dashboard.teacherFacts(value.profile, this.data.session),
        experienceBalances: quotaRows(value.experienceBalances), totals,
        summaryRows: summaryRows(value.summary?.products, totals),
        businessTabs: readyTabs(totals, this.data.businessType),
        businessRecords: dashboard.records(value.page?.records, this.data.businessType),
        businessPage: pageView(value.page), rangeLabel: dashboard.periodLabel(this.data.rangePreset, range.startDate, range.endDate)
      });
    }
    if (customersResult.status === "fulfilled") {
      changes.activeCustomers = customerView(dashboard.customerGroup(customersResult.value.active));
      changes.archivedCustomers = customerView(dashboard.customerGroup(customersResult.value.archived));
    }
    const message = rejectedMessage([workspaceResult, customersResult], "老师工作台读取失败");
    if (message) Object.assign(changes, { message, error: true });
    this.setData(changes);
  },

  async loadStoreHome() {
    const range = dashboard.scopedRange(this.data.rangePreset, { startDate: this.data.rangeStart, endDate: this.data.rangeEnd });
    const config = dashboard.TYPE_CONFIG[this.data.businessType];
    const rangeData = dashboard.payload(range.startDate, range.endDate);
    this.setData({ loading: true, rangeStart: range.startDate, rangeEnd: range.endDate });
    const [storeResult, analyticsResult, recordsResult] = await Promise.allSettled([
      callFace("getStoreDashboard", {
        activeCustomerPage: this.data.activeCustomers.page, archivedCustomerPage: this.data.archivedCustomers.page
      }),
      callFace("getStoreBusinessAnalytics", { ...rangeData, allTime: !range.startDate }),
      callFace("queryStoreBusinessRecords", {
        mode: "browse", statusCategory: "APPROVED", recordType: config.recordType,
        verificationType: config.verificationType, rechargeType: config.rechargeType,
        page: this.data.businessPage.page, pageSize: PAGE_SIZE, ...rangeData
      })
    ]);
    const changes = { loading: false };
    if (storeResult.status === "fulfilled") {
      const store = storeResult.value.store || {};
      const groups = dashboard.storeCustomerGroups(store);
      Object.assign(changes, {
        storeHero: {
          name: String(store.store_name || this.data.session.storeName || "门店"),
          code: String(store.store_code || this.data.session.storeCode || "—"),
          account: String(store.auth_uid || store.store_code || "未绑定登录账号"),
          status: String(store.store_status || "").toUpperCase() === "ARCHIVED" ? "封存" : "活跃"
        },
        profileFacts: dashboard.storeFacts(store),
        activeCustomers: customerView(groups.active), archivedCustomers: customerView(groups.archived)
      });
    }
    if (analyticsResult.status === "fulfilled") {
      const value = analyticsResult.value;
      const totals = dashboard.totals(value.totals);
      Object.assign(changes, {
        totals, summaryRows: summaryRows(value.products, totals),
        businessTabs: readyTabs(totals, this.data.businessType),
        rangeLabel: dashboard.periodLabel(this.data.rangePreset, range.startDate, range.endDate)
      });
    }
    if (recordsResult.status === "fulfilled") {
      const value = recordsResult.value;
      changes.businessRecords = dashboard.records(value.records, this.data.businessType);
      changes.businessPage = pageView(value);
    }
    const message = rejectedMessage([storeResult, analyticsResult, recordsResult], "门店首页读取失败");
    if (message) Object.assign(changes, { message, error: true });
    this.setData(changes);
  },

  async loadBusinessType(page = 1, includeOverview = false) {
    const rangeData = dashboard.payload(this.data.rangeStart, this.data.rangeEnd);
    const type = this.data.businessType;
    this.setData({ businessLoading: true, message: "", error: false });
    try {
      let value;
      if (this.data.session.role === "teacher") {
        value = await callFace("getTeacherWorkspace", {
          recordType: type, page, pageSize: PAGE_SIZE, includeOverview, ...rangeData
        });
        const changes = {
          businessRecords: dashboard.records(value.page?.records, type), businessPage: pageView(value.page)
        };
        if (includeOverview) {
          const totals = dashboard.totals(value.summary?.totals);
          Object.assign(changes, {
            totals, summaryRows: summaryRows(value.summary?.products, totals),
            experienceBalances: quotaRows(value.experienceBalances), businessTabs: readyTabs(totals, type)
          });
        }
        this.setData(changes);
      } else {
        const config = dashboard.TYPE_CONFIG[type];
        value = await callFace("queryStoreBusinessRecords", {
          mode: "browse", statusCategory: "APPROVED", recordType: config.recordType,
          verificationType: config.verificationType, rechargeType: config.rechargeType,
          page, pageSize: PAGE_SIZE, ...rangeData
        });
        this.setData({ businessRecords: dashboard.records(value.records, type), businessPage: pageView(value) });
      }
    } catch (error) {
      this.setData({ message: error.message || "业务明细读取失败", error: true });
    } finally { this.setData({ businessLoading: false }); }
  },

  async loadCustomerPage(status, page) {
    const activePage = status === "ACTIVE" ? page : this.data.activeCustomers.page;
    const archivedPage = status === "ARCHIVED" ? page : this.data.archivedCustomers.page;
    try {
      if (this.data.session.role === "teacher") {
        const value = await callFace("getTeacherBusinessCustomers", { activePage, archivedPage });
        this.setData({
          activeCustomers: customerView(dashboard.customerGroup(value.active)),
          archivedCustomers: customerView(dashboard.customerGroup(value.archived))
        });
      } else {
        const value = await callFace("getStoreDashboard", { activeCustomerPage: activePage, archivedCustomerPage: archivedPage });
        const groups = dashboard.storeCustomerGroups(value.store);
        this.setData({ activeCustomers: customerView(groups.active), archivedCustomers: customerView(groups.archived) });
      }
    } catch (error) { this.setData({ message: error.message || "客户列表读取失败", error: true }); }
  },

  async loadHqHome(pageNumber = 1) {
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    this.setData({ loading: true, hqStart: range.startDate, hqEnd: range.endDate, message: "", error: false });
    const [overviewResult, rankingResult] = await Promise.allSettled([
      callStaff("getHqDashboard", { mode: "overview", startDate: range.startDate, endDate: range.endDate }),
      callStaff("getHqDashboard", {
        mode: "ranking", dimension: this.data.hqDimension, pageNumber, pageSize: RANKING_PAGE_SIZE,
        startDate: range.startDate, endDate: range.endDate
      })
    ]);
    const changes = { loading: false };
    if (overviewResult.status === "fulfilled") {
      const value = overviewResult.value;
      const totals = value.totals || {};
      changes.hqMetrics = [
        ["有效充值次数", totals.recharge, "数据库有效记录"], ["有效核销次数", totals.verification, "数据库有效记录"],
        ["有效体验次数", totals.experience, "数据库有效记录"], ["有效退费次数", totals.refund, "数据库有效记录"],
        ["已纳入门店", totals.stores, "门店主表全部门店"], ["已纳入老师", totals.teachers, "当前日期范围"]
      ].map(([label, valueText, note], index) => ({ label, value: dashboard.count(valueText), note, neutral: index > 3 }));
      changes.hqCharts = [
        { dimension: "store", title: "全局 · 按门店统计", badge: "门店", rows: dashboard.hqRows(value.charts?.store, "store") },
        { dimension: "project", title: "全局 · 按项目统计", badge: "项目", rows: dashboard.hqRows(value.charts?.project, "project") },
        { dimension: "teacher", title: "全局 · 按老师统计", badge: "老师", rows: dashboard.hqRows(value.charts?.teacher, "teacher") }
      ];
    }
    if (rankingResult.status === "fulfilled") {
      const ranking = rankingResult.value.ranking || {};
      const rows = dashboard.hqRows(ranking.rows, this.data.hqDimension);
      const businessTotal = Math.max(1, dashboard.count(ranking.businessTotal));
      changes.hqRanking = rows.map((row, index) => ({
        ...row, rank: (dashboard.count(ranking.pageNumber) - 1) * RANKING_PAGE_SIZE + index + 1,
        share: `${(row.businessTotal / businessTotal * 100).toFixed(1)}%`
      }));
      changes.hqRankingPage = pageView({
        total: ranking.total, page: ranking.pageNumber, pageSize: ranking.pageSize, totalPages: ranking.totalPages
      });
    }
    const message = rejectedMessage([overviewResult, rankingResult], "总部首页读取失败");
    if (message) Object.assign(changes, { message, error: true });
    this.setData(changes);
  },

  selectStore(event) {
    const index = Number(event.detail.value);
    const selected = this.data.stores[index];
    if (!selected) return;
    setSelectedStore(selected, this.data.session);
    this.setData({ selectedStore: selected, storeIndex: index, message: "", error: false });
  },
  toggleBusinessMenu() { this.setData({ businessMenuOpen: !this.data.businessMenuOpen }); },
  chooseRange(event) {
    const preset = event.currentTarget.dataset.preset;
    if (preset === "CUSTOM") {
      const fallback = dashboard.scopedRange("MONTH");
      this.setData({ rangePreset: preset, rangeOptions: readyRangeOptions(preset), customRangeVisible: true,
        rangeStart: this.data.rangeStart || fallback.startDate, rangeEnd: this.data.rangeEnd || fallback.endDate });
      return;
    }
    const range = dashboard.scopedRange(preset);
    this.setData({ rangePreset: preset, rangeOptions: readyRangeOptions(preset), customRangeVisible: false,
      rangeStart: range.startDate, rangeEnd: range.endDate, businessPage: pageView({}) }, () => {
      if (this.data.session.role === "teacher") this.loadTeacherHome(); else this.loadStoreHome();
    });
  },
  changeRangeStart(event) { this.setData({ rangeStart: event.detail.value }); },
  changeRangeEnd(event) { this.setData({ rangeEnd: event.detail.value }); },
  applyCustomRange() {
    const { rangeStart, rangeEnd } = this.data;
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd || dashboard.rangeDays(rangeStart, rangeEnd) > 366) {
      this.setData({ message: "请选择不超过 366 天的有效日期范围", error: true }); return;
    }
    this.setData({ businessPage: pageView({}) }, () => {
      if (this.data.session.role === "teacher") this.loadTeacherHome(); else this.loadStoreHome();
    });
  },
  selectBusinessType(event) {
    const type = event.currentTarget.dataset.type;
    if (!dashboard.TYPE_CONFIG[type]) return;
    this.setData({ businessType: type, businessTabs: readyTabs(this.data.totals, type), businessPage: pageView({}) }, () => this.loadBusinessType(1));
  },
  previousBusinessPage() { if (!this.data.businessPage.previousDisabled) this.loadBusinessType(this.data.businessPage.page - 1); },
  nextBusinessPage() { if (!this.data.businessPage.nextDisabled) this.loadBusinessType(this.data.businessPage.page + 1); },
  customerPage(event) {
    const status = event.currentTarget.dataset.status;
    const direction = Number(event.currentTarget.dataset.direction);
    const group = status === "ARCHIVED" ? this.data.archivedCustomers : this.data.activeCustomers;
    const page = Math.min(group.totalPages, Math.max(1, group.page + direction));
    if (page !== group.page) this.loadCustomerPage(status, page);
  },
  chooseHqPeriod(event) {
    const index = Number(event.detail.value);
    const period = dashboard.HQ_PERIOD_OPTIONS[index]?.value || "LAST_30";
    const range = dashboard.hqRange(period, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    this.setData({ hqPeriod: period, hqPeriodIndex: index, hqStart: range.startDate, hqEnd: range.endDate }, () => {
      if (period !== "CUSTOM") this.loadHqHome(1);
    });
  },
  changeHqStart(event) { this.setData({ hqStart: event.detail.value, hqPeriod: "CUSTOM", hqPeriodIndex: 9 }); },
  changeHqEnd(event) { this.setData({ hqEnd: event.detail.value, hqPeriod: "CUSTOM", hqPeriodIndex: 9 }); },
  applyHqRange() {
    if (!this.data.hqStart || !this.data.hqEnd || this.data.hqStart > this.data.hqEnd || dashboard.rangeDays(this.data.hqStart, this.data.hqEnd) > 366) {
      this.setData({ message: "请选择不超过 366 天的有效日期范围", error: true }); return;
    }
    this.loadHqHome(1);
  },
  resetHqRange() {
    const index = 3;
    const range = dashboard.hqRange("LAST_30");
    this.setData({ hqPeriod: "LAST_30", hqPeriodIndex: index, hqStart: range.startDate, hqEnd: range.endDate }, () => this.loadHqHome(1));
  },
  chooseHqDimension(event) {
    const index = Number(event.detail.value);
    const dimension = DIMENSIONS[index]?.value || "store";
    this.setData({ hqDimension: dimension, hqDimensionIndex: index }, () => this.loadHqHome(1));
  },
  previousHqPage() { if (!this.data.hqRankingPage.previousDisabled) this.loadHqHome(this.data.hqRankingPage.page - 1); },
  nextHqPage() { if (!this.data.hqRankingPage.nextDisabled) this.loadHqHome(this.data.hqRankingPage.page + 1); },

  ensureBusinessStore() {
    const store = getSelectedStore(this.data.session);
    if (!store) { this.setData({ message: "老师办理业务前必须先选择门店", error: true }); return null; }
    return store;
  },
  openCustomerCreate() { if (this.ensureBusinessStore()) wx.navigateTo({ url: "/pages/customer-create/index" }); },
  openRecharge(event) { if (this.ensureBusinessStore()) wx.navigateTo({ url: `/pages/recharge/index?mode=${event.currentTarget.dataset.mode}` }); },
  openVerification(event) { if (this.ensureBusinessStore()) wx.navigateTo({ url: `/pages/verification/index?mode=${event.currentTarget.dataset.mode}` }); },
  openCustomers() { wx.navigateTo({ url: "/pages/customers/index" }); },
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  },
  async logout() { await signOut(); wx.reLaunch({ url: "/pages/login/index" }); }
});

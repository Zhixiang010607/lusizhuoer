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
const RANKING_EXPORT_MAX_ROWS = 10000;

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
function clockText(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":");
}
function hqChart(source, dimension, title, badge) {
  const chart = dashboard.hqChart(source, dimension);
  return { dimension, title, badge, rows: chart.rows, axis: chart.axis };
}
function csvCell(value) {
  const text = String(value === undefined || value === null ? "" : value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function csvLine(values) { return values.map(csvCell).join(","); }
function writeUserFile(path, data) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({
    filePath: path, data, encoding: "utf8", success: resolve, fail: reject
  }));
}
function shareUserFile(path, fileName, fallbackText) {
  if (typeof wx.shareFileMessage === "function") {
    return new Promise((resolve, reject) => wx.shareFileMessage({ filePath: path, fileName, success: resolve, fail: reject }));
  }
  return new Promise((resolve, reject) => wx.setClipboardData({ data: fallbackText, success: resolve, fail: reject }));
}

Page({
  data: {
    session: {}, roleTitle: "", roleSubtitle: "", loading: true, message: "", error: false,
    businessMenuOpen: false, queryMenuOpen: false, managementMenuOpen: false, reviewMenuOpen: false,
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
    hqRanking: [], hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
    hqRankingLoading: false, hqRankingError: "", hqExporting: false, hqLoadedAt: "—", hqScopeDetailText: "正在连接数据库…",
    hqDetailOpen: false, hqDetailTitle: "数据库统计范围", hqDetailText: ""
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
        ["有效充值次数", totals.recharge, "数据库有效记录", "recharge"], ["有效核销次数", totals.verification, "数据库有效记录", "verification"],
        ["有效体验次数", totals.experience, "数据库有效记录", "experience"], ["有效退费次数", totals.refund, "数据库有效记录", "refund"],
        ["已纳入门店", totals.stores, "门店主表全部门店", ""], ["已纳入老师", totals.teachers, "当前日期范围", ""]
      ].map(([label, valueText, note, drill], index) => ({ label, value: dashboard.count(valueText), note, drill, neutral: index > 3 }));
      changes.hqCharts = [
        hqChart(value.charts?.store, "store", "全局 · 按门店统计", "门店"),
        hqChart(value.charts?.project, "project", "全局 · 按项目统计", "项目"),
        hqChart(value.charts?.teacher, "teacher", "全局 · 按老师统计", "老师")
      ];
      changes.hqLoadedAt = clockText();
      changes.hqScopeDetailText = `统计日期：${range.startDate} 至 ${range.endDate}；门店、项目与老师均为全部范围；客户包含活跃及已存档记录；数据库更新：${changes.hqLoadedAt}`;
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
      changes.hqRankingInput = String(changes.hqRankingPage.page);
      changes.hqRankingError = "";
    } else {
      changes.hqRankingError = rankingResult.reason?.message || "总部排名读取失败，请单独重试";
    }
    const message = overviewResult.status === "rejected"
      ? overviewResult.reason?.message || "总部首页读取失败"
      : "";
    if (message) Object.assign(changes, { message, error: true });
    this.setData(changes);
  },

  async loadHqRanking(pageNumber = 1) {
    if (this.data.hqRankingLoading) return;
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    if (!range.startDate || !range.endDate || range.startDate > range.endDate || dashboard.rangeDays(range.startDate, range.endDate) > 366) {
      this.setData({ message: "请选择不超过 366 天的有效日期范围", error: true }); return;
    }
    this.setData({ hqRankingLoading: true, hqRankingError: "", message: "", error: false });
    try {
      const value = await callStaff("getHqDashboard", {
        mode: "ranking", dimension: this.data.hqDimension, pageNumber, pageSize: RANKING_PAGE_SIZE,
        startDate: range.startDate, endDate: range.endDate
      });
      const ranking = value.ranking || {};
      const rows = dashboard.hqRows(ranking.rows, this.data.hqDimension);
      const businessTotal = Math.max(1, dashboard.count(ranking.businessTotal));
      const page = pageView({ total: ranking.total, page: ranking.pageNumber, pageSize: ranking.pageSize, totalPages: ranking.totalPages });
      this.setData({
        hqRanking: rows.map((row, index) => ({
          ...row, rank: (page.page - 1) * RANKING_PAGE_SIZE + index + 1,
          share: `${(row.businessTotal / businessTotal * 100).toFixed(1)}%`
        })),
        hqRankingPage: page, hqRankingInput: String(page.page)
      });
    } catch (error) {
      this.setData({ hqRankingError: error.message || "总部排名读取失败，请单独重试" });
    } finally { this.setData({ hqRankingLoading: false }); }
  },

  selectStore(event) {
    const index = Number(event.detail.value);
    const selected = this.data.stores[index];
    if (!selected) return;
    setSelectedStore(selected, this.data.session);
    this.setData({ selectedStore: selected, storeIndex: index, message: "", error: false });
  },
  closeMenus(changes = {}) {
    this.setData({ businessMenuOpen: false, queryMenuOpen: false, managementMenuOpen: false, reviewMenuOpen: false, ...changes });
  },
  toggleBusinessMenu() { this.closeMenus({ businessMenuOpen: !this.data.businessMenuOpen }); },
  toggleQueryMenu() { this.closeMenus({ queryMenuOpen: !this.data.queryMenuOpen }); },
  toggleManagementMenu() { this.closeMenus({ managementMenuOpen: !this.data.managementMenuOpen }); },
  toggleReviewMenu() { this.closeMenus({ reviewMenuOpen: !this.data.reviewMenuOpen }); },
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
  changeHqStart(event) { this.setData({ hqStart: event.detail.value, hqPeriod: "CUSTOM", hqPeriodIndex: 9 }, () => this.applyHqRange()); },
  changeHqEnd(event) { this.setData({ hqEnd: event.detail.value, hqPeriod: "CUSTOM", hqPeriodIndex: 9 }, () => this.applyHqRange()); },
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
    this.setData({ hqDimension: dimension, hqDimensionIndex: index }, () => this.loadHqRanking(1));
  },
  previousHqPage() { if (!this.data.hqRankingPage.previousDisabled) this.loadHqRanking(this.data.hqRankingPage.page - 1); },
  nextHqPage() { if (!this.data.hqRankingPage.nextDisabled) this.loadHqRanking(this.data.hqRankingPage.page + 1); },
  inputHqPage(event) { this.setData({ hqRankingInput: String(event.detail.value || "") }); },
  jumpHqPage() {
    const raw = String(this.data.hqRankingInput || "").trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
      this.setData({ message: "请输入有效的正整数页码", error: true }); return;
    }
    this.loadHqRanking(Math.min(Number(raw), this.data.hqRankingPage.totalPages));
  },
  retryHqRanking() { this.loadHqRanking(this.data.hqRankingPage.page || 1); },
  openHqDetail(event) {
    const data = event.currentTarget.dataset || {};
    if (data.title && !data.drill) return;
    const title = String(event.currentTarget.dataset.title || event.currentTarget.dataset.name || "有效业务明细");
    this.setData({
      hqDetailOpen: true, hqDetailTitle: "数据库统计范围",
      hqDetailText: `${title}；${this.data.hqScopeDetailText}`
    });
  },
  closeHqDetail() { this.setData({ hqDetailOpen: false }); },
  noop() {},
  async exportHqRanking() {
    if (this.data.loading || this.data.hqRankingLoading || this.data.hqExporting || this.data.hqRankingError) return;
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    const dimension = this.data.hqDimension;
    const dimensionLabel = this.data.hqDimensionLabels[this.data.hqDimensionIndex] || "分类";
    this.setData({ hqExporting: true, message: "正在读取完整排名并生成 CSV…", error: false });
    try {
      const values = [[`${dimensionLabel}编号`, dimensionLabel, "有效充值次数", "有效核销次数", "有效体验次数", "有效退费次数"]];
      let pageNumber = 1;
      let totalPages = 1;
      do {
        const result = await callStaff("getHqDashboard", {
          mode: "ranking", dimension, pageNumber, pageSize: RANKING_PAGE_SIZE,
          startDate: range.startDate, endDate: range.endDate
        });
        const ranking = result.ranking || {};
        const total = dashboard.count(ranking.total);
        if (total > RANKING_EXPORT_MAX_ROWS) throw new Error(`当前${dimensionLabel}排名共有 ${total} 条；请缩小统计日期范围后再导出（单次最多 ${RANKING_EXPORT_MAX_ROWS} 条）`);
        totalPages = Math.max(1, dashboard.count(ranking.totalPages) || Math.ceil(total / RANKING_PAGE_SIZE));
        for (const row of dashboard.hqRows(ranking.rows, dimension)) {
          values.push([row.entityId, row.name, row.recharge, row.verification, row.experience, row.refund]);
        }
        pageNumber += 1;
      } while (pageNumber <= totalPages);
      const csv = `\uFEFF${values.map(csvLine).join("\r\n")}`;
      const fileName = `总部看板${dimensionLabel}排名-${range.startDate}-${range.endDate}.csv`;
      const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;
      await writeUserFile(filePath, csv);
      await shareUserFile(filePath, fileName, csv);
      this.setData({ message: typeof wx.shareFileMessage === "function" ? "排名 CSV 已生成" : "当前环境不支持分享文件，CSV 已复制", error: false });
    } catch (error) {
      const cancelled = /cancel/i.test(String(error && (error.errMsg || error.message) || ""));
      this.setData({ message: cancelled ? "已取消分享" : error.message || error.errMsg || "排名导出失败", error: !cancelled });
    } finally { this.setData({ hqExporting: false }); }
  },

  ensureBusinessStore() {
    const store = getSelectedStore(this.data.session);
    if (!store) { this.setData({ message: "老师办理业务前必须先选择门店", error: true }); return null; }
    return store;
  },
  openCustomerCreate() { if (this.ensureBusinessStore()) wx.navigateTo({ url: "/pages/customer-create/index" }); },
  openRecharge(event) { if (this.ensureBusinessStore()) wx.navigateTo({ url: `/pages/recharge/index?mode=${event.currentTarget.dataset.mode}` }); },
  openVerification(event) { if (this.ensureBusinessStore()) wx.navigateTo({ url: `/pages/verification/index?mode=${event.currentTarget.dataset.mode}` }); },
  openCustomers() { wx.navigateTo({ url: "/pages/customers/index" }); },
  openQuery(event) {
    const type = String(event.currentTarget.dataset.type || "customer");
    this.setData({ queryMenuOpen: false });
    if (type === "customer") wx.navigateTo({ url: "/pages/customers/index" });
    else wx.navigateTo({ url: `/pages/records/index?type=${type}` });
  },
  openManagement(event) {
    const type = String(event.currentTarget.dataset.type || "product");
    this.closeMenus();
    if (type === "product") wx.navigateTo({ url: "/pages/product-management/index" });
    else wx.navigateTo({ url: `/pages/hq-directory/index?type=${encodeURIComponent(type)}` });
  },
  openReview(event) {
    const type = String(event.currentTarget.dataset.type || "recharge");
    this.closeMenus();
    wx.navigateTo({ url: `/pages/reviews/index?type=${encodeURIComponent(type)}` });
  },
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  },
  openOrder(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const code = String(event.currentTarget.dataset.code || "");
    const category = String(event.currentTarget.dataset.category || this.data.businessType || "RECHARGE").toUpperCase();
    const config = dashboard.TYPE_CONFIG[category];
    if (!id || !config) return;
    wx.navigateTo({
      url: `/pages/order-detail/index?type=${config.recordType.toLowerCase()}&category=${category}&recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}`
    });
  },
  async logout() { await signOut(); wx.reLaunch({ url: "/pages/login/index" }); }
});

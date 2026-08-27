const { callFace, callStaff } = require("../../services/api");
const { waitForStartupSession, requireSession, getSelectedStore, signOut } = require("../../services/session");
const dashboard = require("../../services/home-dashboard");
const hqReport = require("../../services/hq-dashboard-report");

const ROLE_META = Object.freeze({
  hq: { title: "总部数据看板", subtitle: "真实数据库统计 · 默认显示今天" },
  store: { title: "门店全局视图", subtitle: "业务汇总与门店资料" },
  teacher: { title: "我的工作台", subtitle: "查看本人有效业务、项目汇总与体验项目剩余次数" }
});
const DIMENSIONS = Object.freeze([
  { value: "store", label: "门店" },
  { value: "teacher", label: "老师" }
]);
const RANKING_METRICS = Object.freeze([
  { value: "recharge", label: "充值" },
  { value: "verification", label: "核销" },
  { value: "experience", label: "体验" },
  { value: "refund", label: "退费" }
]);
const PAGE_SIZE = 10;
const RANKING_PAGE_SIZE = 100;
const PRODUCT_SUMMARY_PAGE_SIZE = 10;
const REPORT_EXPORT_PAGE_SIZE = 500;
const REPORT_EXPORT_MAX_ROWS = 10000;

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
function customerView(group) {
  const rows = Array.isArray(group?.rows) ? group.rows : [];
  const visibleRows = Math.min(5, Math.max(1, rows.length));
  return { ...group, ...pageView(group), viewportHeight: 72 + visibleRows * 82 };
}
function rejectedMessage(results, fallback) {
  const failed = results.find((item) => item.status === "rejected");
  return failed ? failed.reason?.message || fallback : "";
}
function clockText(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":");
}
function hqChart(source, dimension, title, badge, rankingMetric = "recharge") {
  const chart = dashboard.hqChart(source, dimension);
  const maximum = Math.max(1, ...chart.rows.map((row) => dashboard.count(row[rankingMetric])));
  const rows = chart.rows.map((row, index) => {
    const rankValue = dashboard.count(row[rankingMetric]);
    return { ...row, rank: index + 1, rankValue, barWidth: `${Math.max(rankValue ? 4 : 0, rankValue / maximum * 100).toFixed(1)}%` };
  });
  return { dimension, title, badge, rankingMetric, rows, axis: chart.axis };
}
function hqRankingMatches(ranking, dimension, rankingMetric, productId) {
  return String(ranking?.dimension || "") === dimension
    && String(ranking?.rankingMetric || "") === rankingMetric
    && String(ranking?.productId || "") === String(productId || "");
}
function hqProductSummaryRows(items = []) {
  return (Array.isArray(items) ? items : []).map((row) => ({
    productId: String(row.entityId || row.entity_id || ""),
    productName: String(row.entityName || row.entity_name || "未命名项目"),
    recharge: dashboard.count(row.recharge !== undefined ? row.recharge : row.recharge_count),
    verification: dashboard.count(row.verification !== undefined ? row.verification : row.verification_count),
    experience: dashboard.count(row.experience !== undefined ? row.experience : row.experience_count),
    refund: dashboard.count(row.refund !== undefined ? row.refund : row.refund_count)
  }));
}
function hqProductSummaryView(payload = {}) {
  const summary = payload.productSummary;
  if (!summary || !Array.isArray(summary.rows)) throw new Error("总部项目汇总服务版本过旧，请先部署 staffAccount v75");
  return {
    rows: hqProductSummaryRows(summary.rows),
    page: pageView({
      total: summary.total,
      page: summary.pageNumber,
      pageSize: summary.pageSize,
      totalPages: summary.totalPages
    })
  };
}
function wxCall(invoke) { return new Promise((resolve, reject) => invoke(resolve, reject)); }
function openPdfDocument(filePath) {
  if (typeof wx.openDocument !== "function") return Promise.reject(new Error("当前微信版本无法打开 PDF，请升级微信后重试"));
  return wxCall((resolve, reject) => wx.openDocument({ filePath, fileType: "pdf", showMenu: true, success: resolve, fail: reject }));
}
function reportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

Page({
  data: {
    session: {}, roleTitle: "", roleSubtitle: "", loading: true, message: "", error: false,
    businessMenuOpen: false, queryMenuOpen: false, managementMenuOpen: false, reviewMenuOpen: false,
    rangePreset: "TODAY", rangeOptions: readyRangeOptions("TODAY"), rangeStart: "", rangeEnd: "",
    rangeLabel: "本月", customRangeVisible: false,
    profileFacts: [], storeHero: {}, experienceBalances: [], summaryRows: [],
    totals: { ...dashboard.EMPTY_TOTALS }, businessType: "VERIFICATION",
    businessTabs: readyTabs(dashboard.EMPTY_TOTALS, "VERIFICATION"), businessRecords: [],
    businessPage: pageView({}), businessPageInput: "1", businessScrollLeft: 0, summaryScrollLeft: 0, businessLoading: false,
    activeCustomers: customerView(dashboard.customerGroup()), archivedCustomers: customerView(dashboard.customerGroup()),
    activeCustomerScrollLeft: 0, archivedCustomerScrollLeft: 0,
    hqPeriodOptions: dashboard.HQ_PERIOD_OPTIONS, hqPeriodLabels: dashboard.HQ_PERIOD_OPTIONS.map((item) => item.label),
    hqPeriod: "TODAY", hqPeriodIndex: 0, hqStart: "", hqEnd: "",
    hqMetrics: [], hqCharts: [], hqDimensions: DIMENSIONS,
    hqProjectSummaryRows: [], hqProjectSummaryPage: pageView({ pageSize: PRODUCT_SUMMARY_PAGE_SIZE }),
    hqProjectSummaryTotals: { ...dashboard.EMPTY_TOTALS }, hqProjectSummaryLoading: false, hqProjectSummaryError: "",
    hqDimensionLabels: DIMENSIONS.map((item) => item.label), hqDimension: "store", hqDimensionIndex: 0,
    hqRankingMetrics: RANKING_METRICS, hqRankingMetricLabels: RANKING_METRICS.map((item) => item.label),
    hqRankingMetric: "recharge", hqRankingMetricIndex: 0,
    hqProducts: [{ id: "", label: "全部项目" }], hqProductLabels: ["全部项目"], hqProductId: "", hqProductIndex: 0,
    hqRanking: [], hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1", hqRankingScrollLeft: 0,
    hqRankingLoading: false, hqRankingError: "", hqExporting: false, hqLoadedAt: "—"
  },

  async onShow() {
    const startupEpoch = Number(this._startupEpoch || 0) + 1;
    this._startupEpoch = startupEpoch;
    await waitForStartupSession();
    if (startupEpoch !== this._startupEpoch) return;
    const session = requireSession();
    if (!session) return;
    const meta = ROLE_META[session.role] || { title: "工作台", subtitle: "" };
    this.setData({ session, roleTitle: meta.title, roleSubtitle: meta.subtitle, message: "", error: false });
    if (session.role === "teacher") this.loadTeacherHome();
    else if (session.role === "store") this.loadStoreHome();
    else this.loadHqHome();
  },

  onUnload() {
    this._startupEpoch = Number(this._startupEpoch || 0) + 1;
    for (const key of [
      "_teacherHomeRequestEpoch", "_storeHomeRequestEpoch", "_businessRequestEpoch",
      "_customerRequestEpoch", "_hqHomeRequestEpoch", "_hqRankingRequestEpoch"
    ]) this[key] = Number(this[key] || 0) + 1;
  },

  async loadTeacherHome() {
    const requestEpoch = (this._teacherHomeRequestEpoch || 0) + 1;
    this._teacherHomeRequestEpoch = requestEpoch;
    this._businessRequestEpoch = (this._businessRequestEpoch || 0) + 1;
    this._customerRequestEpoch = (this._customerRequestEpoch || 0) + 1;
    const businessRequestEpoch = this._businessRequestEpoch;
    const customerRequestEpoch = this._customerRequestEpoch;
    const businessType = this.data.businessType;
    const businessPage = this.data.businessPage.page;
    const activeCustomerPage = this.data.activeCustomers.page;
    const archivedCustomerPage = this.data.archivedCustomers.page;
    const range = dashboard.scopedRange(this.data.rangePreset, { startDate: this.data.rangeStart, endDate: this.data.rangeEnd });
    this.setData({
      loading: true,
      rangeStart: range.startDate, rangeEnd: range.endDate,
      profileFacts: [], experienceBalances: [], summaryRows: [], totals: { ...dashboard.EMPTY_TOTALS },
      businessTabs: readyTabs(dashboard.EMPTY_TOTALS, businessType), businessRecords: [],
      businessPage: pageView({}), businessPageInput: "1", businessScrollLeft: 0, summaryScrollLeft: 0,
      activeCustomers: customerView(dashboard.customerGroup()), archivedCustomers: customerView(dashboard.customerGroup()),
      activeCustomerScrollLeft: 0, archivedCustomerScrollLeft: 0
    });
    const [workspaceResult, customersResult] = await Promise.allSettled([
      callFace("getTeacherWorkspace", {
        recordType: businessType, page: businessPage, pageSize: PAGE_SIZE,
        includeOverview: true, ...dashboard.payload(range.startDate, range.endDate)
      }),
      callFace("getTeacherBusinessCustomers", {
        activePage: activeCustomerPage, archivedPage: archivedCustomerPage
      })
    ]);
    if (requestEpoch !== this._teacherHomeRequestEpoch) return;
    const changes = { loading: false, message: "", error: false };
    if (workspaceResult.status === "fulfilled") {
      const value = workspaceResult.value;
      const totals = dashboard.totals(value.summary?.totals);
      Object.assign(changes, {
        profileFacts: dashboard.teacherFacts(value.profile, this.data.session),
        experienceBalances: quotaRows(value.experienceBalances), totals,
        summaryRows: summaryRows(value.summary?.products, totals),
        businessTabs: readyTabs(totals, this.data.businessType),
        rangeLabel: dashboard.periodLabel(this.data.rangePreset, range.startDate, range.endDate)
      });
      if (businessRequestEpoch === this._businessRequestEpoch && this.data.businessType === businessType) {
        Object.assign(changes, {
          businessRecords: dashboard.records(value.page?.records, businessType),
          businessPage: pageView(value.page), businessPageInput: String(pageView(value.page).page), businessScrollLeft: 0
        });
      }
    }
    if (customersResult.status === "fulfilled" && customerRequestEpoch === this._customerRequestEpoch) {
      changes.activeCustomers = customerView(dashboard.customerGroup(customersResult.value.active));
      changes.archivedCustomers = customerView(dashboard.customerGroup(customersResult.value.archived));
    }
    const message = rejectedMessage([workspaceResult, customersResult], "老师工作台读取失败");
    if (message) Object.assign(changes, { message, error: true });
    this.setData(changes);
  },

  async loadStoreHome() {
    const requestEpoch = Number(this._storeHomeRequestEpoch || 0) + 1;
    this._storeHomeRequestEpoch = requestEpoch;
    this._businessRequestEpoch = Number(this._businessRequestEpoch || 0) + 1;
    this._customerRequestEpoch = Number(this._customerRequestEpoch || 0) + 1;
    const businessRequestEpoch = this._businessRequestEpoch;
    const customerRequestEpoch = this._customerRequestEpoch;
    const businessType = this.data.businessType;
    const activeCustomerPage = this.data.activeCustomers.page;
    const archivedCustomerPage = this.data.archivedCustomers.page;
    const businessPage = this.data.businessPage.page;
    const range = dashboard.scopedRange(this.data.rangePreset, { startDate: this.data.rangeStart, endDate: this.data.rangeEnd });
    const config = dashboard.TYPE_CONFIG[businessType];
    const rangeData = dashboard.payload(range.startDate, range.endDate);
    this.setData({
      loading: true, rangeStart: range.startDate, rangeEnd: range.endDate, message: "", error: false,
      storeHero: {}, profileFacts: [], summaryRows: [], totals: { ...dashboard.EMPTY_TOTALS },
      businessTabs: readyTabs(dashboard.EMPTY_TOTALS, businessType), businessRecords: [],
      businessPage: pageView({}), businessPageInput: "1", businessScrollLeft: 0, summaryScrollLeft: 0,
      activeCustomers: customerView(dashboard.customerGroup()), archivedCustomers: customerView(dashboard.customerGroup()),
      activeCustomerScrollLeft: 0, archivedCustomerScrollLeft: 0
    });
    const [storeResult, analyticsResult, recordsResult] = await Promise.allSettled([
      callFace("getStoreDashboard", {
        activeCustomerPage, archivedCustomerPage
      }),
      callFace("getStoreBusinessAnalytics", { ...rangeData, allTime: !range.startDate }),
      callFace("queryStoreBusinessRecords", {
        mode: "browse", statusCategory: "APPROVED", recordType: config.recordType,
        verificationType: config.verificationType, rechargeType: config.rechargeType,
        page: businessPage, pageSize: PAGE_SIZE, ...rangeData
      })
    ]);
    if (requestEpoch !== this._storeHomeRequestEpoch) return;
    const changes = { loading: false, message: "", error: false };
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
        profileFacts: dashboard.storeFacts(store)
      });
      if (customerRequestEpoch === this._customerRequestEpoch) {
        changes.activeCustomers = customerView(groups.active);
        changes.archivedCustomers = customerView(groups.archived);
      }
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
    if (recordsResult.status === "fulfilled"
        && businessRequestEpoch === this._businessRequestEpoch
        && this.data.businessType === businessType) {
      const value = recordsResult.value;
      changes.businessRecords = dashboard.records(value.records, businessType);
      changes.businessPage = pageView(value);
      changes.businessPageInput = String(changes.businessPage.page);
      changes.businessScrollLeft = 0;
    }
    const message = rejectedMessage([storeResult, analyticsResult, recordsResult], "门店首页读取失败");
    if (message) Object.assign(changes, { message, error: true });
    this.setData(changes);
  },

  async loadBusinessType(page = 1, includeOverview = false) {
    const rangeData = dashboard.payload(this.data.rangeStart, this.data.rangeEnd);
    const type = this.data.businessType;
    const requestEpoch = (this._businessRequestEpoch || 0) + 1;
    this._businessRequestEpoch = requestEpoch;
    this.setData({
      businessLoading: true, businessRecords: [], businessPage: pageView({}), businessPageInput: "1",
      businessScrollLeft: 0, message: "", error: false,
      ...(includeOverview ? {
        totals: { ...dashboard.EMPTY_TOTALS }, summaryRows: [], experienceBalances: [],
        businessTabs: readyTabs(dashboard.EMPTY_TOTALS, type), summaryScrollLeft: 0
      } : {})
    });
    try {
      let value;
      if (this.data.session.role === "teacher") {
        value = await callFace("getTeacherWorkspace", {
          recordType: type, page, pageSize: PAGE_SIZE, includeOverview, ...rangeData
        });
        const changes = {
          businessRecords: dashboard.records(value.page?.records, type), businessPage: pageView(value.page),
          businessPageInput: String(pageView(value.page).page), businessScrollLeft: 0
        };
        if (includeOverview) {
          const totals = dashboard.totals(value.summary?.totals);
          Object.assign(changes, {
            totals, summaryRows: summaryRows(value.summary?.products, totals),
            experienceBalances: quotaRows(value.experienceBalances), businessTabs: readyTabs(totals, type)
          });
        }
        if (requestEpoch !== this._businessRequestEpoch || this.data.businessType !== type) return;
        this.setData(changes);
      } else {
        const config = dashboard.TYPE_CONFIG[type];
        value = await callFace("queryStoreBusinessRecords", {
          mode: "browse", statusCategory: "APPROVED", recordType: config.recordType,
          verificationType: config.verificationType, rechargeType: config.rechargeType,
          page, pageSize: PAGE_SIZE, ...rangeData
        });
        if (requestEpoch !== this._businessRequestEpoch || this.data.businessType !== type) return;
        const businessPage = pageView(value);
        this.setData({
          businessRecords: dashboard.records(value.records, type), businessPage,
          businessPageInput: String(businessPage.page), businessScrollLeft: 0
        });
      }
    } catch (error) {
      if (requestEpoch === this._businessRequestEpoch && this.data.businessType === type) {
        this.setData({
          businessRecords: [], businessPage: pageView({}), businessPageInput: "1", businessScrollLeft: 0,
          message: error.message || "业务明细读取失败", error: true
        });
      }
    } finally {
      if (requestEpoch === this._businessRequestEpoch && this.data.businessType === type) this.setData({ businessLoading: false });
    }
  },

  async loadCustomerPage(status, page) {
    const requestEpoch = (this._customerRequestEpoch || 0) + 1;
    this._customerRequestEpoch = requestEpoch;
    const activePage = status === "ACTIVE" ? page : this.data.activeCustomers.page;
    const archivedPage = status === "ARCHIVED" ? page : this.data.archivedCustomers.page;
    const targetChanges = status === "ARCHIVED"
      ? { archivedCustomers: customerView(dashboard.customerGroup()), archivedCustomerScrollLeft: 0 }
      : { activeCustomers: customerView(dashboard.customerGroup()), activeCustomerScrollLeft: 0 };
    this.setData({ ...targetChanges, message: "", error: false });
    try {
      if (this.data.session.role === "teacher") {
        const value = await callFace("getTeacherBusinessCustomers", { activePage, archivedPage });
        if (requestEpoch !== this._customerRequestEpoch) return;
        this.setData({
          activeCustomers: customerView(dashboard.customerGroup(value.active)),
          archivedCustomers: customerView(dashboard.customerGroup(value.archived))
        });
      } else {
        const value = await callFace("getStoreDashboard", { activeCustomerPage: activePage, archivedCustomerPage: archivedPage });
        const groups = dashboard.storeCustomerGroups(value.store);
        if (requestEpoch !== this._customerRequestEpoch) return;
        this.setData({ activeCustomers: customerView(groups.active), archivedCustomers: customerView(groups.archived) });
      }
    } catch (error) {
      if (requestEpoch === this._customerRequestEpoch) this.setData({ ...targetChanges, message: error.message || "客户列表读取失败", error: true });
    }
  },

  async loadHqHome(pageNumber = 1) {
    const requestEpoch = Number(this._hqHomeRequestEpoch || 0) + 1;
    this._hqHomeRequestEpoch = requestEpoch;
    const rankingRequestEpoch = Number(this._hqRankingRequestEpoch || 0) + 1;
    this._hqRankingRequestEpoch = rankingRequestEpoch;
    const productSummaryRequestEpoch = Number(this._hqProductSummaryRequestEpoch || 0) + 1;
    this._hqProductSummaryRequestEpoch = productSummaryRequestEpoch;
    this._hqRankingRetryPage = pageNumber;
    const dimension = this.data.hqDimension;
    const rankingMetric = this.data.hqRankingMetric;
    const productId = this.data.hqProductId;
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    this.setData({
      loading: true, hqRankingLoading: true, hqProjectSummaryLoading: true, hqStart: range.startDate, hqEnd: range.endDate,
      hqMetrics: [], hqCharts: [], hqLoadedAt: "—",
      hqProjectSummaryRows: [], hqProjectSummaryPage: pageView({ pageSize: PRODUCT_SUMMARY_PAGE_SIZE }),
      hqProjectSummaryTotals: { ...dashboard.EMPTY_TOTALS }, hqProjectSummaryError: "",
      hqRanking: [], hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
      hqRankingScrollLeft: 0, hqRankingError: "", message: "", error: false
    });
    const [overviewResult, rankingResult, productResult, productSummaryResult] = await Promise.allSettled([
      callStaff("getHqDashboard", { mode: "overview", startDate: range.startDate, endDate: range.endDate }),
      callStaff("getHqDashboard", {
        mode: "ranking", dimension, rankingMetric, productId, pageNumber, pageSize: RANKING_PAGE_SIZE,
        startDate: range.startDate, endDate: range.endDate
      }),
      callStaff("listProducts"),
      callStaff("getHqDashboard", {
        mode: "product-summary", pageNumber: 1, pageSize: PRODUCT_SUMMARY_PAGE_SIZE,
        startDate: range.startDate, endDate: range.endDate
      })
    ]);
    if (requestEpoch !== this._hqHomeRequestEpoch) return;
    const changes = { loading: false, message: "", error: false };
    if (overviewResult.status === "fulfilled") {
      const value = overviewResult.value;
      const totals = value.totals || {};
      changes.hqMetrics = [
        ["有效充值次数", totals.recharge, "recharge"], ["有效核销次数", totals.verification, "verification"],
        ["有效体验次数", totals.experience, "experience"], ["有效退费次数", totals.refund, "refund"],
        ["已纳入门店", totals.stores, ""], ["已纳入老师", totals.teachers, ""]
      ].map(([label, valueText, drill], index) => ({ label, value: dashboard.count(valueText), drill, neutral: index > 3 }));
      changes.hqProjectSummaryTotals = dashboard.totals(totals);
      changes.hqLoadedAt = clockText();
    }
    if (productSummaryRequestEpoch === this._hqProductSummaryRequestEpoch) {
      changes.hqProjectSummaryLoading = false;
      if (productSummaryResult.status === "fulfilled") {
        try {
          const summary = hqProductSummaryView(productSummaryResult.value);
          changes.hqProjectSummaryRows = summary.rows;
          changes.hqProjectSummaryPage = summary.page;
          changes.hqProjectSummaryError = "";
        } catch (summaryError) {
          changes.hqProjectSummaryRows = [];
          changes.hqProjectSummaryError = summaryError.message || "总部项目汇总返回格式无效";
        }
      } else {
        changes.hqProjectSummaryRows = [];
        changes.hqProjectSummaryError = productSummaryResult.reason?.message || "总部项目汇总读取失败";
      }
    }
    if (productResult.status === "fulfilled") {
      const products = [{ id: "", label: "全部项目" }, ...(productResult.value.products || []).map((item) => ({
        id: String(item.id || ""),
        label: `${String(item.product_name || item.productName || "未命名项目")}${item.product_code ? ` · ${item.product_code}` : ""}${String(item.product_status || "").toUpperCase() === "ARCHIVED" ? "（已封存）" : ""}`
      })).filter((item) => item.id)];
      changes.hqProducts = products;
      changes.hqProductLabels = products.map((item) => item.label);
      const selectedProductIndex = Math.max(0, products.findIndex((item) => item.id === productId));
      changes.hqProductIndex = selectedProductIndex;
      changes.hqProductId = products[selectedProductIndex]?.id || "";
    }
    const currentRankingRequest = rankingRequestEpoch === this._hqRankingRequestEpoch
      && dimension === this.data.hqDimension && rankingMetric === this.data.hqRankingMetric && productId === this.data.hqProductId;
    if (currentRankingRequest) changes.hqRankingLoading = false;
    if (currentRankingRequest && rankingResult.status === "fulfilled"
      && hqRankingMatches(rankingResult.value.ranking, dimension, rankingMetric, productId)) {
      const ranking = rankingResult.value.ranking || {};
      const rows = dashboard.hqRows(ranking.rows, dimension);
      const rankingTotal = Math.max(1, dashboard.count(ranking.rankingTotal));
      changes.hqRanking = rows.map((row, index) => ({
        ...row, rank: (dashboard.count(ranking.pageNumber) - 1) * RANKING_PAGE_SIZE + index + 1,
        rankValue: row[rankingMetric], share: `${(row[rankingMetric] / rankingTotal * 100).toFixed(1)}%`
      }));
      changes.hqCharts = [hqChart(ranking.rows, dimension, `按${DIMENSIONS[this.data.hqDimensionIndex]?.label || "分类"}统计`, DIMENSIONS[this.data.hqDimensionIndex]?.label || "分类", rankingMetric)];
      changes.hqRankingPage = pageView({
        total: ranking.total, page: ranking.pageNumber, pageSize: ranking.pageSize, totalPages: ranking.totalPages
      });
      this._hqRankingRetryPage = changes.hqRankingPage.page;
      changes.hqRankingInput = String(changes.hqRankingPage.page);
      changes.hqRankingError = "";
    } else if (currentRankingRequest) {
      changes.hqRankingError = rankingResult.status === "rejected"
        ? rankingResult.reason?.message || "总部排名读取失败，请单独重试"
        : "总部排名服务版本过旧，请先部署 staffAccount v75";
    }
    const message = overviewResult.status === "rejected"
      ? overviewResult.reason?.message || "总部首页读取失败"
      : "";
    if (message) Object.assign(changes, { message, error: true });
    this.setData(changes);
  },

  async loadHqRanking(pageNumber = 1) {
    const requestEpoch = Number(this._hqRankingRequestEpoch || 0) + 1;
    this._hqRankingRequestEpoch = requestEpoch;
    this._hqRankingRetryPage = pageNumber;
    const dimension = this.data.hqDimension;
    const rankingMetric = this.data.hqRankingMetric;
    const productId = this.data.hqProductId;
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    if (!range.startDate || !range.endDate || range.startDate > range.endDate || dashboard.rangeDays(range.startDate, range.endDate) > 366) {
      this.setData({
        hqRanking: [], hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
        hqRankingScrollLeft: 0, hqRankingLoading: false, hqRankingError: "请选择不超过 366 天的有效日期范围",
        message: "请选择不超过 366 天的有效日期范围", error: true
      });
      return;
    }
    this.setData({
      hqRanking: [], hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
      hqRankingScrollLeft: 0, hqRankingLoading: true, hqRankingError: "", message: "", error: false
    });
    try {
      const value = await callStaff("getHqDashboard", {
        mode: "ranking", dimension, rankingMetric, productId, pageNumber, pageSize: RANKING_PAGE_SIZE,
        startDate: range.startDate, endDate: range.endDate
      });
      if (requestEpoch !== this._hqRankingRequestEpoch || dimension !== this.data.hqDimension
        || rankingMetric !== this.data.hqRankingMetric || productId !== this.data.hqProductId) return;
      const ranking = value.ranking || {};
      if (!hqRankingMatches(ranking, dimension, rankingMetric, productId)) {
        throw new Error("总部排名服务版本过旧，请先部署 staffAccount v75");
      }
      const rows = dashboard.hqRows(ranking.rows, dimension);
      const rankingTotal = Math.max(1, dashboard.count(ranking.rankingTotal));
      const page = pageView({ total: ranking.total, page: ranking.pageNumber, pageSize: ranking.pageSize, totalPages: ranking.totalPages });
      this._hqRankingRetryPage = page.page;
      this.setData({
        hqRanking: rows.map((row, index) => ({
          ...row, rank: (page.page - 1) * RANKING_PAGE_SIZE + index + 1,
          rankValue: row[rankingMetric], share: `${(row[rankingMetric] / rankingTotal * 100).toFixed(1)}%`
        })),
        hqRankingPage: page, hqRankingInput: String(page.page)
      });
      if (page.page === 1) this.setData({ hqCharts: [hqChart(ranking.rows, dimension, "分类统计", DIMENSIONS[this.data.hqDimensionIndex]?.label || "分类", rankingMetric)] });
    } catch (error) {
      if (requestEpoch === this._hqRankingRequestEpoch && dimension === this.data.hqDimension
        && rankingMetric === this.data.hqRankingMetric && productId === this.data.hqProductId) {
        this.setData({ hqRankingError: error.message || "总部排名读取失败，请单独重试" });
      }
    } finally {
      if (requestEpoch === this._hqRankingRequestEpoch && dimension === this.data.hqDimension
        && rankingMetric === this.data.hqRankingMetric && productId === this.data.hqProductId) {
        this.setData({ hqRankingLoading: false });
      }
    }
  },

  closeMenus(changes = {}) {
    this.setData({ businessMenuOpen: false, queryMenuOpen: false, managementMenuOpen: false, reviewMenuOpen: false, ...changes });
  },
  toggleBusinessMenu() { this.closeMenus({ businessMenuOpen: !this.data.businessMenuOpen }); },
  toggleQueryMenu() { this.closeMenus({ queryMenuOpen: !this.data.queryMenuOpen }); },
  toggleManagementMenu() { this.closeMenus({ managementMenuOpen: !this.data.managementMenuOpen }); },
  toggleReviewMenu() { this.closeMenus({ reviewMenuOpen: !this.data.reviewMenuOpen }); },
  jumpToSection(event) {
    const selector = String(event.currentTarget.dataset.target || "");
    if (!/^#[a-z][a-z0-9-]*$/i.test(selector)) return;
    wx.pageScrollTo({ selector, duration: 220 });
  },
  chooseRange(event) {
    const preset = event.currentTarget.dataset.preset;
    if (preset === "CUSTOM") {
      const fallback = dashboard.scopedRange("TODAY");
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
    this.setData({
      businessType: type, businessTabs: readyTabs(this.data.totals, type), businessRecords: [],
      businessPage: pageView({}), businessPageInput: "1", businessScrollLeft: 0
    }, () => this.loadBusinessType(1));
  },
  previousBusinessPage() { if (!this.data.businessPage.previousDisabled) this.loadBusinessType(this.data.businessPage.page - 1); },
  nextBusinessPage() { if (!this.data.businessPage.nextDisabled) this.loadBusinessType(this.data.businessPage.page + 1); },
  inputBusinessPage(event) { this.setData({ businessPageInput: String(event.detail.value || "") }); },
  jumpBusinessPage() {
    const raw = String(this.data.businessPageInput || "").trim();
    const page = Number(raw);
    const totalPages = Math.max(1, Number(this.data.businessPage.totalPages || 1));
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1 || page > totalPages) {
      this.setData({ message: `请输入 1 至 ${totalPages} 之间的页码`, error: true });
      return;
    }
    return this.loadBusinessType(page);
  },
  rememberSummaryScroll(event) {
    const value = Number(event.detail && event.detail.scrollLeft);
    if (Number.isFinite(value) && value >= 0) this.data.summaryScrollLeft = value;
  },
  rememberBusinessScroll(event) {
    const value = Number(event.detail && event.detail.scrollLeft);
    if (Number.isFinite(value) && value >= 0) this.data.businessScrollLeft = value;
  },
  rememberCustomerScroll(event) {
    const value = Number(event.detail && event.detail.scrollLeft);
    const status = String(event.currentTarget.dataset.status || "ACTIVE");
    if (!Number.isFinite(value) || value < 0) return;
    if (status === "ARCHIVED") this.data.archivedCustomerScrollLeft = value;
    else this.data.activeCustomerScrollLeft = value;
  },
  customerPage(event) {
    const status = event.currentTarget.dataset.status;
    const direction = Number(event.currentTarget.dataset.direction);
    const group = status === "ARCHIVED" ? this.data.archivedCustomers : this.data.activeCustomers;
    const page = Math.min(group.totalPages, Math.max(1, group.page + direction));
    if (page !== group.page) this.loadCustomerPage(status, page);
  },
  chooseHqPeriod(event) {
    const index = Number(event.detail.value);
    const period = dashboard.HQ_PERIOD_OPTIONS[index]?.value || "TODAY";
    const range = dashboard.hqRange(period, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    this.setData({ hqPeriod: period, hqPeriodIndex: index, hqStart: range.startDate, hqEnd: range.endDate }, () => {
      if (period !== "CUSTOM") this.loadHqHome(1);
    });
  },
  changeHqStart(event) { this.setData({ hqStart: event.detail.value, hqPeriod: "CUSTOM", hqPeriodIndex: dashboard.HQ_PERIOD_OPTIONS.findIndex((item) => item.value === "CUSTOM") }, () => this.applyHqRange()); },
  changeHqEnd(event) { this.setData({ hqEnd: event.detail.value, hqPeriod: "CUSTOM", hqPeriodIndex: dashboard.HQ_PERIOD_OPTIONS.findIndex((item) => item.value === "CUSTOM") }, () => this.applyHqRange()); },
  applyHqRange() {
    if (!this.data.hqStart || !this.data.hqEnd || this.data.hqStart > this.data.hqEnd || dashboard.rangeDays(this.data.hqStart, this.data.hqEnd) > 366) {
      this._hqHomeRequestEpoch = Number(this._hqHomeRequestEpoch || 0) + 1;
      this._hqRankingRequestEpoch = Number(this._hqRankingRequestEpoch || 0) + 1;
      this._hqRankingRetryPage = 1;
      this.setData({
        loading: false, hqRankingLoading: false,
        hqMetrics: [], hqCharts: [], hqLoadedAt: "—",
        hqRanking: [], hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
        hqRankingScrollLeft: 0, hqRankingError: "请选择不超过 366 天的有效日期范围",
        message: "请选择不超过 366 天的有效日期范围", error: true
      });
      return;
    }
    this.loadHqHome(1);
  },
  resetHqRange() {
    const range = dashboard.hqRange("TODAY");
    this.setData({
      hqPeriod: "TODAY", hqPeriodIndex: 0, hqStart: range.startDate, hqEnd: range.endDate,
      hqDimension: "store", hqDimensionIndex: 0,
      hqProductId: "", hqProductIndex: 0,
      hqRankingMetric: "recharge", hqRankingMetricIndex: 0
    }, () => this.loadHqHome(1));
  },
  async loadHqProjectSummary(pageNumber) {
    const requestEpoch = Number(this._hqProductSummaryRequestEpoch || 0) + 1;
    this._hqProductSummaryRequestEpoch = requestEpoch;
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    this.setData({
      hqProjectSummaryLoading: true,
      hqProjectSummaryRows: [],
      hqProjectSummaryError: ""
    });
    try {
      const payload = await callStaff("getHqDashboard", {
        mode: "product-summary", pageNumber, pageSize: PRODUCT_SUMMARY_PAGE_SIZE,
        startDate: range.startDate, endDate: range.endDate
      });
      if (requestEpoch !== this._hqProductSummaryRequestEpoch) return;
      const summary = hqProductSummaryView(payload);
      this.setData({
        hqProjectSummaryLoading: false,
        hqProjectSummaryRows: summary.rows,
        hqProjectSummaryPage: summary.page,
        hqProjectSummaryError: ""
      });
    } catch (error) {
      if (requestEpoch !== this._hqProductSummaryRequestEpoch) return;
      this.setData({
        hqProjectSummaryLoading: false,
        hqProjectSummaryRows: [],
        hqProjectSummaryError: error.message || "总部项目汇总读取失败"
      });
    }
  },
  previousHqProductSummaryPage() {
    if (!this.data.hqProjectSummaryPage.previousDisabled && !this.data.hqProjectSummaryLoading) {
      this.loadHqProjectSummary(this.data.hqProjectSummaryPage.page - 1);
    }
  },
  nextHqProductSummaryPage() {
    if (!this.data.hqProjectSummaryPage.nextDisabled && !this.data.hqProjectSummaryLoading) {
      this.loadHqProjectSummary(this.data.hqProjectSummaryPage.page + 1);
    }
  },
  chooseHqDimension(event) {
    if (this.data.hqRankingLoading || this.data.hqExporting) return;
    const index = Number(event.currentTarget?.dataset?.index ?? event.detail?.value);
    const dimension = DIMENSIONS[index]?.value || "store";
    this.setData({ hqDimension: dimension, hqDimensionIndex: index }, () => this.loadHqRanking(1));
  },
  chooseHqRankingMetric(event) {
    if (this.data.hqRankingLoading || this.data.hqExporting) return;
    const index = Number(event.currentTarget.dataset.index);
    const rankingMetric = RANKING_METRICS[index]?.value || "recharge";
    this.setData({ hqRankingMetric: rankingMetric, hqRankingMetricIndex: index }, () => this.loadHqRanking(1));
  },
  chooseHqProduct(event) {
    if (this.data.hqRankingLoading || this.data.hqExporting) return;
    const index = Number(event.detail.value || 0);
    const product = this.data.hqProducts[index] || this.data.hqProducts[0] || { id: "" };
    this.setData({ hqProductIndex: index, hqProductId: product.id || "" }, () => this.loadHqRanking(1));
  },
  previousHqPage() { if (!this.data.hqRankingPage.previousDisabled) this.loadHqRanking(this.data.hqRankingPage.page - 1); },
  nextHqPage() { if (!this.data.hqRankingPage.nextDisabled) this.loadHqRanking(this.data.hqRankingPage.page + 1); },
  rememberHqRankingScroll(event) {
    const scrollLeft = Number(event.detail && event.detail.scrollLeft);
    if (Number.isFinite(scrollLeft) && scrollLeft >= 0) this.data.hqRankingScrollLeft = scrollLeft;
  },
  inputHqPage(event) { this.setData({ hqRankingInput: String(event.detail.value || "") }); },
  jumpHqPage() {
    const raw = String(this.data.hqRankingInput || "").trim();
    const page = Number(raw);
    if (!/^\d+$/.test(raw) || page < 1 || !Number.isSafeInteger(page)) {
      this.setData({ message: "请输入有效的正整数页码", error: true }); return;
    }
    const totalPages = Math.max(1, Number(this.data.hqRankingPage.totalPages || 1));
    if (page > totalPages) {
      this.setData({ message: `请输入 1 至 ${totalPages} 之间的页码`, error: true }); return;
    }
    return this.loadHqRanking(page);
  },
  retryHqRanking() { return this.loadHqRanking(this._hqRankingRetryPage || this.data.hqRankingPage.page || 1); },
  openHqQuery(event) {
    const drill = String(event.currentTarget.dataset.drill || "").toLowerCase();
    if (!["recharge", "refund", "verification", "experience"].includes(drill)) return;
    const type = ["recharge", "refund"].includes(drill) ? "recharge" : "verification";
    wx.navigateTo({ url: `/pages/records/index?type=${type}&drill=${drill}&startDate=${encodeURIComponent(this.data.hqStart)}&endDate=${encodeURIComponent(this.data.hqEnd)}` });
  },
  noop() {},
  async exportHqRanking() {
    if (this.data.loading || this.data.hqRankingLoading || this.data.hqExporting || this.data.hqRankingError) return;
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    const dimension = this.data.hqDimension;
    const rankingMetric = this.data.hqRankingMetric;
    const productId = this.data.hqProductId;
    const dimensionLabel = this.data.hqDimensionLabels[this.data.hqDimensionIndex] || "分类";
    this.setData({ hqExporting: true, message: "正在读取项目汇总与完整排名…", error: false });
    try {
      const productRows = [];
      let productPageNumber = 1;
      let productTotalPages = 1;
      do {
        this.setData({ message: `正在读取项目汇总 ${productPageNumber} / ${productTotalPages}…`, error: false });
        const result = await callStaff("getHqDashboard", {
          mode: "product-summary", pageNumber: productPageNumber, pageSize: REPORT_EXPORT_PAGE_SIZE,
          startDate: range.startDate, endDate: range.endDate
        });
        const summary = hqProductSummaryView(result);
        if (summary.page.total > REPORT_EXPORT_MAX_ROWS) throw new Error(`项目汇总共有 ${summary.page.total} 项，单次 PDF 最多绘制 ${REPORT_EXPORT_MAX_ROWS} 项`);
        if (productRows.length + summary.rows.length > REPORT_EXPORT_MAX_ROWS) throw new Error(`单次 PDF 最多绘制 ${REPORT_EXPORT_MAX_ROWS} 个项目`);
        productTotalPages = Math.max(1, summary.page.totalPages);
        productRows.push(...summary.rows.map((row) => ({ name: row.productName, ...row })));
        productPageNumber += 1;
      } while (productPageNumber <= productTotalPages);

      const rankingRows = [];
      let pageNumber = 1;
      let totalPages = 1;
      let rankingTotal = 0;
      do {
        this.setData({ message: `正在读取完整排名 ${pageNumber} / ${totalPages}…`, error: false });
        const result = await callStaff("getHqDashboard", {
          mode: "ranking", dimension, rankingMetric, productId,
          pageNumber, pageSize: REPORT_EXPORT_PAGE_SIZE,
          startDate: range.startDate, endDate: range.endDate
        });
        const ranking = result.ranking || {};
        if (!hqRankingMatches(ranking, dimension, rankingMetric, productId)) {
          throw new Error("总部排名服务版本过旧，请先部署 staffAccount v75");
        }
        const total = dashboard.count(ranking.total);
        if (total > REPORT_EXPORT_MAX_ROWS) throw new Error(`当前${dimensionLabel}排名共有 ${total} 条；请缩小统计日期范围后再导出（单次最多 ${REPORT_EXPORT_MAX_ROWS} 条）`);
        totalPages = Math.max(1, dashboard.count(ranking.totalPages) || Math.ceil(total / REPORT_EXPORT_PAGE_SIZE));
        const rows = dashboard.hqRows(ranking.rows, dimension);
        if (rankingRows.length + rows.length > REPORT_EXPORT_MAX_ROWS) throw new Error(`单次 PDF 最多绘制 ${REPORT_EXPORT_MAX_ROWS} 条排名`);
        rankingRows.push(...rows);
        rankingTotal = dashboard.count(ranking.rankingTotal) || rankingTotal;
        pageNumber += 1;
      } while (pageNumber <= totalPages);

      this.setData({ message: "正在绘制矢量 PDF…", error: false });
      const metricLabel = this.data.hqRankingMetricLabels[this.data.hqRankingMetricIndex] || "业务";
      const productLabel = this.data.hqProductLabels[this.data.hqProductIndex] || "全部项目";
      const output = hqReport.createReportPdf({
        startDate: range.startDate, endDate: range.endDate, dimensionLabel,
        metric: rankingMetric, metricLabel, productLabel, generatedAt: reportTimestamp(),
        productRows, totals: this.data.hqProjectSummaryTotals, rankingRows, rankingTotal
      });
      const baseName = hqReport.safeFilename(`露思卓儿总部-${range.startDate}至${range.endDate}-${dimensionLabel}-${metricLabel}排名`);
      const filePath = `${wx.env.USER_DATA_PATH}/${baseName}.pdf`;
      const bytes = output.bytes;
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await wxCall((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: buffer, success: resolve, fail: reject }));
      await openPdfDocument(filePath);
      this.setData({ message: `矢量 PDF 已打开，共 ${output.pages} 页；可通过右上角菜单分享或保存。`, error: false });
    } catch (error) {
      const cancelled = /cancel/i.test(String(error && (error.errMsg || error.message) || ""));
      this.setData({ message: cancelled ? "已取消打开 PDF" : error.message || error.errMsg || "矢量 PDF 导出失败", error: !cancelled });
    } finally { this.setData({ hqExporting: false }); }
  },

  ensureBusinessStore() {
    if (this.data.session.role === "teacher") return true;
    const store = getSelectedStore(this.data.session);
    if (!store) { this.setData({ message: "当前登录门店读取失败，请重新登录后再办理业务", error: true }); return null; }
    return store;
  },
  openCustomerCreate() { this.closeMenus(); if (this.ensureBusinessStore()) wx.navigateTo({ url: "/pages/customer-create/index" }); },
  openRecharge(event) { this.closeMenus(); if (this.ensureBusinessStore()) wx.navigateTo({ url: `/pages/recharge/index?mode=${event.currentTarget.dataset.mode}` }); },
  openProductPurchase() { this.closeMenus(); if (this.ensureBusinessStore()) wx.navigateTo({ url: "/pages/product-purchase/index" }); },
  openVerification(event) { this.closeMenus(); if (this.ensureBusinessStore()) wx.navigateTo({ url: `/pages/verification/index?mode=${event.currentTarget.dataset.mode}` }); },
  openCustomers() { wx.navigateTo({ url: "/pages/customers/index" }); },
  openQuery(event) {
    const type = String(event.currentTarget.dataset.type || "customer");
    this.setData({ queryMenuOpen: false });
    if (type === "customer") wx.navigateTo({ url: "/pages/customers/index" });
    else wx.navigateTo({ url: `/pages/records/index?type=${type}` });
  },
  openManagement(event) {
    const type = String(event.currentTarget.dataset.type || "project");
    this.closeMenus();
    if (type === "project") wx.navigateTo({ url: "/pages/product-management/index" });
    else if (type === "product") wx.navigateTo({ url: "/pages/retail-product-management/index" });
    else wx.navigateTo({ url: `/pages/hq-directory/index?type=${encodeURIComponent(type)}` });
  },
  openReview(event) {
    const type = String(event.currentTarget.dataset.type || "recharge");
    if (!["recharge", "product-purchase"].includes(type)) return;
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
    const category = String(event.currentTarget.dataset.category || "").toUpperCase();
    const config = dashboard.TYPE_CONFIG[category];
    if (!id || !config) return;
    wx.navigateTo({
      url: `/pages/order-detail/index?type=${config.recordType.toLowerCase()}&category=${category}&recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}`
    });
  },
  async logout() {
    try { await signOut(); }
    finally { wx.reLaunch({ url: "/pages/login/index" }); }
  }
});

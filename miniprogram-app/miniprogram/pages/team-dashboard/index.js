const { callFace, callStaff } = require("../../services/api");
const { waitForStartupSession, requireSession, getSelectedStore, signOut } = require("../../services/session");
const dashboard = require("../../services/home-dashboard");

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
const RANKING_PAGE_SIZE = 10;
const PRODUCT_SUMMARY_PAGE_SIZE = 10;

function readyRangeOptions(active) {
  return dashboard.RANGE_OPTIONS.map((item) => ({ ...item, active: item.value === active }));
}
function readyTabs(totals, active) { return dashboard.tabs(totals, active); }
function summaryRows(products) { return dashboard.products(products); }
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
  const visibleRows = Math.min(10, Math.max(1, rows.length));
  const page = pageView(group);
  return {
    ...group, ...page,
    pageInput: String(page.page),
    viewportHeight: 64 + visibleRows * 72,
    tabletVisibleRows: Math.min(10, rows.length),
    scrollable: rows.length > 10
  };
}
function businessRecordsView(items, type) {
  const businessRecords = dashboard.records(items, type);
  const visibleRows = Math.min(10, businessRecords.length);
  return {
    businessRecords,
    businessViewportHeight: 64 + (visibleRows ? visibleRows * 72 : 104),
    businessTabletVisibleRows: visibleRows,
    businessScrollable: businessRecords.length > 10
  };
}
function rankingView(items = []) {
  const rows = (Array.isArray(items) ? items : []).map((row) => ({
    ...row,
    // Use the master code accepted by both existing detail routes; numeric
    // teacher IDs can otherwise collide with an unrelated staff-account ID.
    profileRef: /^[1-9]\d*$/.test(String(row.entityId || "")) ? String(row.entityId || "").trim() : ""
  }));
  const visibleRows = Math.min(10, rows.length);
  return {
    hqRanking: rows,
    hqRankingVisibleRows: visibleRows,
    hqRankingViewportHeight: 64 + (visibleRows ? visibleRows * 72 : 104),
    hqRankingScrollable: rows.length > 10
  };
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
  if (!summary || !Array.isArray(summary.rows)) throw new Error("总部项目汇总服务版本过旧，请先部署 staffAccount v76");
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
function hqRangePayload(period, range) {
  return period === "ALL" ? { allTime: true } : { startDate: range.startDate, endDate: range.endDate };
}
const {requireTeamAccess,teacherUrl}=require("../../services/teacher-team");
// Dedicated member-scoped subpage; the original teacher/HQ home stays intact.

Page({
 data:{"authorized":false,"loading":false,"message":"","error":false,"session":{"role":"teacher"},"hqPeriodOptions":[{"value":"TODAY","label":"今天"},{"value":"WEEK","label":"本周"},{"value":"MONTH","label":"本月"},{"value":"QUARTER","label":"本季度"},{"value":"YEAR","label":"本年"},{"value":"ALL","label":"全部"},{"value":"CUSTOM","label":"自定义"}],"hqPeriodLabels":["今天","本周","本月","本季度","本年","全部","自定义"],"hqPeriod":"TODAY","hqPeriodIndex":0,"hqStart":"","hqEnd":"","hqMetrics":[],"hqCharts":[],"hqDimensions":[{"value":"store","label":"门店"},{"value":"teacher","label":"老师"}],"hqProjectSummaryRows":[],"hqProjectSummaryPage":{"total":0,"page":1,"pageSize":10,"totalPages":1,"previousDisabled":true,"nextDisabled":true},"hqProjectSummaryTotals":{"verification":0,"recharge":0,"experience":0,"refund":0},"hqProjectSummaryTotalsReady":false,"hqProjectSummaryLoading":true,"hqProjectSummaryError":"","hqDimensionLabels":["门店","老师"],"hqDimension":"store","hqDimensionIndex":0,"hqRankingMetrics":[{"value":"recharge","label":"充值"},{"value":"verification","label":"核销"},{"value":"experience","label":"体验"},{"value":"refund","label":"退费"}],"hqRankingMetricLabels":["充值","核销","体验","退费"],"hqRankingMetric":"recharge","hqRankingMetricIndex":0,"hqProducts":[{"id":"","label":"全部项目"}],"hqProductLabels":["全部项目"],"hqProductId":"","hqProductIndex":0,"hqRanking":[],"hqRankingVisibleRows":0,"hqRankingViewportHeight":168,"hqRankingScrollable":false,"hqRankingPage":{"total":0,"page":1,"pageSize":10,"totalPages":1,"previousDisabled":true,"nextDisabled":true},"hqRankingInput":"1","hqRankingScrollLeft":0,"hqRankingLoading":false,"hqRankingError":"","hqExporting":false,"hqLoadedAt":"—"},

  async onShow(){const epoch=this._authEpoch=(this._authEpoch||0)+1;this.setData({authorized:false,...rankingView([]),hqProjectSummaryRows:[],hqProjectSummaryTotalsReady:false,hqProjectSummaryTotals:{verification:0,recharge:0,experience:0,refund:0},hqProjectSummaryPage:pageView({total:0,page:1,pageSize:10,totalPages:1}),hqRankingPage:pageView({total:0,page:1,pageSize:10,totalPages:1}),hqMetrics:[],hqCharts:[],message:"",error:false});try{await requireTeamAccess();if(epoch!==this._authEpoch)return;this.setData({authorized:true});await this.loadHqHome();}catch(error){if(epoch===this._authEpoch)this.setData({authorized:false,message:error.message,error:true});}},
  onUnload(){this._authEpoch=(this._authEpoch||0)+1;for(const key of ["_hqHomeRequestEpoch","_hqRankingRequestEpoch","_hqProductSummaryRequestEpoch"])this[key]=(this[key]||0)+1;},
  onPullDownRefresh(){this.onShow().finally(()=>wx.stopPullDownRefresh());},
  back(){wx.navigateBack();},
  async readTeam(action,payload){try{return await callStaff(action==="getHqDashboard"||action==="listProducts"?"getTeamDashboard":action,action==="listProducts"?{mode:"products"}:payload);}catch(error){if(["FORBIDDEN","UNAUTHENTICATED","TEAM_SCHEMA_NOT_READY"].includes(error.code)){this._hqHomeRequestEpoch=(this._hqHomeRequestEpoch||0)+1;this._hqRankingRequestEpoch=(this._hqRankingRequestEpoch||0)+1;this._hqProductSummaryRequestEpoch=(this._hqProductSummaryRequestEpoch||0)+1;this.setData({authorized:false,...rankingView([]),hqProjectSummaryRows:[],hqProjectSummaryTotalsReady:false,hqProjectSummaryTotals:{verification:0,recharge:0,experience:0,refund:0},hqProjectSummaryPage:pageView({total:0,page:1,pageSize:10,totalPages:1}),hqRankingPage:pageView({total:0,page:1,pageSize:10,totalPages:1}),hqMetrics:[],hqCharts:[],message:error.message,error:true,loading:false,hqRankingLoading:false,hqProjectSummaryLoading:false});}throw error;}},
  async openHqRankedProfile(event){const {id,dimension}=event.currentTarget.dataset;if(!this.data.authorized||dimension!=="teacher"||this.data.hqDimension!=="teacher"||!this.data.hqRanking.some(row=>row.entityId===String(id)))return;wx.navigateTo({url:teacherUrl(id)});},
async loadHqHome(pageNumber = 1) {
    const requestEpoch = Number(this._hqHomeRequestEpoch || 0) + 1;
    this._hqHomeRequestEpoch = requestEpoch;
    const rankingRequestEpoch = Number(this._hqRankingRequestEpoch || 0) + 1;
    this._hqRankingRequestEpoch = rankingRequestEpoch;
    const productSummaryRequestEpoch = Number(this._hqProductSummaryRequestEpoch || 0) + 1;
    this._hqProductSummaryRequestEpoch = productSummaryRequestEpoch;
    this._hqRankingRetryPage = pageNumber;
    this._hqProductSummaryRetryPage = 1;
    const dimension = this.data.hqDimension;
    const rankingMetric = this.data.hqRankingMetric;
    const productId = this.data.hqProductId;
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    this.setData({
      loading: true, hqRankingLoading: true, hqProjectSummaryLoading: true, hqStart: range.startDate, hqEnd: range.endDate,
      hqMetrics: [], hqCharts: [], hqLoadedAt: "—",
      hqProjectSummaryRows: [], hqProjectSummaryPage: pageView({ pageSize: PRODUCT_SUMMARY_PAGE_SIZE }),
      hqProjectSummaryTotals: { ...dashboard.EMPTY_TOTALS }, hqProjectSummaryTotalsReady: false, hqProjectSummaryError: "",
      ...rankingView([]), hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
      hqRankingScrollLeft: 0, hqRankingError: "", message: "", error: false
    });
    const [overviewResult, rankingResult, productResult, productSummaryResult] = await Promise.allSettled([
      this.readTeam("getHqDashboard", { mode: "overview", ...hqRangePayload(this.data.hqPeriod, range) }),
      this.readTeam("getHqDashboard", {
        mode: "ranking", dimension, rankingMetric, productId, pageNumber, pageSize: RANKING_PAGE_SIZE,
        ...hqRangePayload(this.data.hqPeriod, range)
      }),
      this.readTeam("listProducts"),
      this.readTeam("getHqDashboard", {
        mode: "product-summary", pageNumber: 1, pageSize: PRODUCT_SUMMARY_PAGE_SIZE,
        ...hqRangePayload(this.data.hqPeriod, range)
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
      changes.hqProjectSummaryTotalsReady = true;
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
          changes.hqProjectSummaryError = summaryError.message || "小组项目汇总返回格式无效";
        }
      } else {
        changes.hqProjectSummaryRows = [];
        changes.hqProjectSummaryError = productSummaryResult.reason?.message || "小组项目汇总读取失败";
      }
    }
    if (productResult.status === "fulfilled") {
      const products = [{ id: "", label: "全部项目" }, ...(productResult.value.products || []).map((item) => ({
        id: String(item.id || ""),
        label: `${String(item.product_name || item.productName || "未命名项目")}${String(item.product_status || "").toUpperCase() === "ARCHIVED" ? "（已封存）" : ""}`
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
      Object.assign(changes, rankingView(rows.map((row, index) => ({
        ...row,
        rank: (dashboard.count(ranking.pageNumber) - 1) * RANKING_PAGE_SIZE + index + 1
      }))));
      changes.hqCharts = [hqChart(ranking.rows, dimension, `按${DIMENSIONS[this.data.hqDimensionIndex]?.label || "分类"}统计`, DIMENSIONS[this.data.hqDimensionIndex]?.label || "分类", rankingMetric)];
      changes.hqRankingPage = pageView({
        total: ranking.total, page: ranking.pageNumber, pageSize: ranking.pageSize, totalPages: ranking.totalPages
      });
      this._hqRankingRetryPage = changes.hqRankingPage.page;
      changes.hqRankingInput = String(changes.hqRankingPage.page);
      changes.hqRankingError = "";
    } else if (currentRankingRequest) {
      changes.hqRankingError = rankingResult.status === "rejected"
        ? rankingResult.reason?.message || "小组排名读取失败，请单独重试"
        : "小组排名服务版本过旧，请先部署 staffAccount v76";
    }
    const message = overviewResult.status === "rejected"
      ? overviewResult.reason?.message || "小组首页读取失败"
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
    if (this.data.hqPeriod !== "ALL"
      && (!range.startDate || !range.endDate || range.startDate > range.endDate || dashboard.rangeDays(range.startDate, range.endDate) > 366)) {
      this.setData({
        ...rankingView([]), hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
        hqRankingScrollLeft: 0, hqRankingLoading: false, hqRankingError: "请选择不超过 366 天的有效日期范围",
        message: "请选择不超过 366 天的有效日期范围", error: true
      });
      return;
    }
    this.setData({
      ...rankingView([]), hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
      hqRankingScrollLeft: 0, hqRankingLoading: true, hqRankingError: "", message: "", error: false
    });
    try {
      const value = await this.readTeam("getHqDashboard", {
        mode: "ranking", dimension, rankingMetric, productId, pageNumber, pageSize: RANKING_PAGE_SIZE,
        ...hqRangePayload(this.data.hqPeriod, range)
      });
      if (requestEpoch !== this._hqRankingRequestEpoch || dimension !== this.data.hqDimension
        || rankingMetric !== this.data.hqRankingMetric || productId !== this.data.hqProductId) return;
      const ranking = value.ranking || {};
      if (!hqRankingMatches(ranking, dimension, rankingMetric, productId)) {
        throw new Error("小组排名服务版本过旧，请先部署 staffAccount v76");
      }
      const rows = dashboard.hqRows(ranking.rows, dimension);
      const page = pageView({ total: ranking.total, page: ranking.pageNumber, pageSize: ranking.pageSize, totalPages: ranking.totalPages });
      this._hqRankingRetryPage = page.page;
      this.setData({
        ...rankingView(rows.map((row, index) => ({
          ...row,
          rank: (page.page - 1) * RANKING_PAGE_SIZE + index + 1
        }))),
        hqRankingPage: page, hqRankingInput: String(page.page)
      });
      if (page.page === 1) this.setData({ hqCharts: [hqChart(ranking.rows, dimension, "分类统计", DIMENSIONS[this.data.hqDimensionIndex]?.label || "分类", rankingMetric)] });
    } catch (error) {
      if (requestEpoch === this._hqRankingRequestEpoch && dimension === this.data.hqDimension
        && rankingMetric === this.data.hqRankingMetric && productId === this.data.hqProductId) {
        this.setData({ hqRankingError: error.message || "小组排名读取失败，请单独重试" });
      }
    } finally {
      if (requestEpoch === this._hqRankingRequestEpoch && dimension === this.data.hqDimension
        && rankingMetric === this.data.hqRankingMetric && productId === this.data.hqProductId) {
        this.setData({ hqRankingLoading: false });
      }
    }
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
        ...rankingView([]), hqRankingPage: pageView({ pageSize: RANKING_PAGE_SIZE }), hqRankingInput: "1",
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
retryHqProjectSummary() {
    if (this.data.hqProjectSummaryLoading) return;
    if (!this.data.hqProjectSummaryTotalsReady) return this.loadHqHome(1);
    return this.loadHqProjectSummary(this._hqProductSummaryRetryPage || 1);
  },
async loadHqProjectSummary(pageNumber) {
    this._hqProductSummaryRetryPage = pageNumber;
    const requestEpoch = Number(this._hqProductSummaryRequestEpoch || 0) + 1;
    this._hqProductSummaryRequestEpoch = requestEpoch;
    const range = dashboard.hqRange(this.data.hqPeriod, { startDate: this.data.hqStart, endDate: this.data.hqEnd });
    this.setData({
      hqProjectSummaryLoading: true,
      hqProjectSummaryRows: [],
      hqProjectSummaryError: ""
    });
    try {
      const payload = await this.readTeam("getHqDashboard", {
        mode: "product-summary", pageNumber, pageSize: PRODUCT_SUMMARY_PAGE_SIZE,
        ...hqRangePayload(this.data.hqPeriod, range)
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
        hqProjectSummaryError: error.message || "小组项目汇总读取失败"
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
async exportHqRanking() {
    this.setData({ message: "小组总览不支持导出，请使用打卡或日报页面的导出。", error: true });
  }
});

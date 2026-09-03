const { callRating } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");

const PAGE_SIZE = 20;
const SCORE_COLORS = Object.freeze(["#b9aea0", "#a9554b", "#c87348", "#c39945", "#82905e", "#47745e"]);
const EMPTY_SUMMARY = Object.freeze({ total: 0, rated: 0, unrated: 0, scoreCounts: [0, 0, 0, 0, 0, 0] });

function labels(options) { return options.map((item) => item.label); }
function values(options) { return options.map((item) => item.value); }
function percentage(count, total) { return total > 0 ? `${(Number(count || 0) * 100 / total).toFixed(1)}%` : "0.0%"; }
function statusSuffix(status) { return String(status || "").toUpperCase() === "ARCHIVED" ? "（已封存）" : ""; }

function scoreOptions(selected = [0, 1, 2, 3, 4, 5]) {
  const chosen = new Set(selected.map(Number));
  return [0, 1, 2, 3, 4, 5].map((score) => ({
    score,
    label: score === 0 ? "0 未评价" : `${score} 分`,
    selected: chosen.has(score)
  }));
}

function normalizeSummary(source = {}) {
  const counts = Array.from({ length: 6 }, (_, score) => Number(source.scoreCounts?.[score] || 0));
  const total = Number(source.total || 0);
  const rated = Number(source.rated || 0);
  const unrated = Number(source.unrated ?? Math.max(0, total - rated));
  const ratedCounts = counts.slice(1);
  return {
    total, rated, unrated, scoreCounts: counts,
    coveragePercent: percentage(rated, total),
    scoreLegend: ratedCounts.map((count, index) => ({
      score: index + 1,
      label: `${index + 1} 分`,
      count,
      percentage: percentage(count, rated),
      color: SCORE_COLORS[index + 1]
    })),
    coverageLegend: [
      { label: "已评价", count: rated, percentage: percentage(rated, total), color: "#9b7335" },
      { label: "未评价", count: unrated, percentage: percentage(unrated, total), color: "#d8cbb8" }
    ]
  };
}

function normalizeOrders(rows = []) {
  return rows.map((row) => {
    const score = Number(row.effectiveScore || 0);
    const rated = score > 0;
    const teacherName = String(row.teacherName || "");
    return {
      ...row,
      rowKey: String(row.id || row.recordCode || ""),
      id: String(row.id || ""),
      recordCode: String(row.recordCode || "—"),
      customerCode: String(row.customerCode || ""),
      customerName: String(row.customerName || "—"),
      storeName: String(row.storeName || "—"),
      productName: String(row.productName || "—"),
      teacherName: teacherName || "未指定",
      serviceTime: String(row.serviceTime || "—"),
      verificationType: String(row.verificationType || "NORMAL").toUpperCase() === "EXPERIENCE" ? "EXPERIENCE" : "NORMAL",
      effectiveScore: score,
      effectiveScoreLabel: rated ? `${score} 分` : "未评价",
      storeScoreLabel: rated ? `${Number(row.storeEnvironmentScore || 0)} 分` : "—",
      teacherScoreLabel: rated && teacherName ? `${Number(row.teacherServiceScore || 0)} 分` : "—",
      overallScoreLabel: rated ? `${Number(row.overallExperienceScore || 0)} 分` : "—"
    };
  });
}

Page({
  data: {
    session: {}, loading: false, searched: false, message: "", error: false, tableScrollLeft: 0,
    stores: [], storeLabels: ["全部门店"], storeIndex: 0,
    products: [], productLabels: ["全部项目"], productIndex: 0,
    teachers: [], teacherLabels: ["全部老师", "未指定老师"], teacherValues: ["", "NONE"], teacherIndex: 0,
    timeLabels: labels(query.TIME_OPTIONS), timeValues: values(query.TIME_OPTIONS), ...query.defaultTimeFilter(),
    today: query.businessToday(), scoreOptions: scoreOptions(), selectedScores: [0, 1, 2, 3, 4, 5],
    orders: [], summary: normalizeSummary(EMPTY_SUMMARY),
    page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1, pageJump: "1"
  },

  async onLoad() {
    const session = requireSession(["hq", "store"]);
    if (!session) return;
    this.setData({ session });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    await this.loadOptions();
  },

  onPullDownRefresh() {
    const action = this.loadOptions().then(() => this.data.searched ? this.load(1) : undefined);
    action.finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this._optionEpoch = Number(this._optionEpoch || 0) + 1;
    this._chartEpoch = Number(this._chartEpoch || 0) + 1;
    this._scrollResetEpoch = Number(this._scrollResetEpoch || 0) + 1;
  },

  async loadOptions() {
    const epoch = Number(this._optionEpoch || 0) + 1;
    this._optionEpoch = epoch;
    const selectedStoreId = this.data.storeIndex > 0 ? this.data.stores[this.data.storeIndex - 1]?.id : "";
    const selectedProductId = this.data.productIndex > 0 ? this.data.products[this.data.productIndex - 1]?.id : "";
    const selectedTeacherId = this.data.teacherValues[this.data.teacherIndex] || "";
    try {
      const result = await callRating("getRatingAnalysisOptions");
      if (epoch !== this._optionEpoch) return;
      const stores = (result.stores || []).map((item) => ({
        id: String(item.id || ""), name: String(item.name || "未命名门店"),
        label: `${String(item.name || "未命名门店")}${statusSuffix(item.status)}`
      })).filter((item) => item.id);
      const products = (result.products || []).map((item) => ({
        id: String(item.id || ""), name: String(item.name || "未命名项目"),
        label: `${String(item.name || "未命名项目")}${statusSuffix(item.status)}`
      })).filter((item) => item.id);
      const teachers = (result.teachers || []).map((item) => ({
        id: String(item.id || ""), name: String(item.name || "未命名老师"),
        label: `${String(item.name || "未命名老师")}${statusSuffix(item.status)}`
      })).filter((item) => item.id);
      const teacherValues = ["", "NONE", ...teachers.map((item) => item.id)];
      this.setData({
        stores, storeLabels: ["全部门店", ...stores.map((item) => item.label)],
        storeIndex: selectedStoreId ? Math.max(0, stores.findIndex((item) => item.id === selectedStoreId) + 1) : 0,
        products, productLabels: ["全部项目", ...products.map((item) => item.label)],
        productIndex: selectedProductId ? Math.max(0, products.findIndex((item) => item.id === selectedProductId) + 1) : 0,
        teachers, teacherLabels: ["全部老师", "未指定老师", ...teachers.map((item) => item.label)], teacherValues,
        teacherIndex: Math.max(0, teacherValues.indexOf(selectedTeacherId))
      });
    } catch (error) {
      if (epoch === this._optionEpoch) this.setData({ message: error.message || "评价查询选项读取失败", error: true });
    }
  },

  clearResults(changes = {}) {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this._chartEpoch = Number(this._chartEpoch || 0) + 1;
    this.setData({
      ...changes, loading: false, searched: false, orders: [], summary: normalizeSummary(EMPTY_SUMMARY),
      page: 1, total: 0, totalPages: 1, pageJump: "1", tableScrollLeft: 0, message: "", error: false
    });
  },

  chooseStore(event) { this.clearResults({ storeIndex: Number(event.detail.value) }); },
  chooseProduct(event) { this.clearResults({ productIndex: Number(event.detail.value) }); },
  chooseTeacher(event) { this.clearResults({ teacherIndex: Number(event.detail.value) }); },
  chooseTime(event) {
    const timeIndex = Number(event.detail.value);
    const value = this.data.timeValues[timeIndex] || "TODAY";
    const range = query.timeRange(value, { startDate: this.data.startDate, endDate: this.data.endDate });
    this.clearResults({ timeIndex, customRange: value === "CUSTOM", startDate: range.startDate, endDate: range.endDate });
  },
  changeStart(event) { this.clearResults({ startDate: event.detail.value }); },
  changeEnd(event) { this.clearResults({ endDate: event.detail.value }); },

  toggleScore(event) {
    const score = Number(event.currentTarget.dataset.score);
    if (!Number.isInteger(score) || score < 0 || score > 5) return;
    const selected = new Set(this.data.selectedScores.map(Number));
    if (selected.has(score)) {
      if (selected.size === 1) {
        this.setData({ message: "至少保留一个评分条件", error: true });
        return;
      }
      selected.delete(score);
    } else selected.add(score);
    const selectedScores = [...selected].sort((left, right) => left - right);
    this.clearResults({ selectedScores, scoreOptions: scoreOptions(selectedScores) });
  },

  payload(page) {
    const result = { pageNumber: page, pageSize: PAGE_SIZE, scores: this.data.selectedScores.slice() };
    if (this.data.session.role === "hq" && this.data.storeIndex > 0) {
      result.storeId = this.data.stores[this.data.storeIndex - 1]?.id || "";
    }
    if (this.data.productIndex > 0) result.productId = this.data.products[this.data.productIndex - 1]?.id || "";
    const teacherId = this.data.teacherValues[this.data.teacherIndex] || "";
    if (teacherId) result.teacherId = teacherId;
    result.startDate = this.data.startDate || "";
    result.endDate = this.data.endDate || "";
    return result;
  },

  validRange() {
    const start = String(this.data.startDate || "");
    const end = String(this.data.endDate || "");
    if ((!start && end) || (start && !end)) return "开始日期和结束日期必须同时填写";
    if (start && start > end) return "开始日期不能晚于结束日期";
    if (start && (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 > 366) {
      return "自定义时间范围不能超过 366 天";
    }
    return "";
  },

  search() {
    const rangeError = this.validRange();
    if (rangeError) { this.setData({ message: rangeError, error: true }); return; }
    if (!this.data.selectedScores.length) { this.setData({ message: "请至少选择一个评分", error: true }); return; }
    this.load(1);
  },

  async load(page = 1) {
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const targetPage = Math.max(1, Number(page) || 1);
    this.setData({ loading: true, message: "", error: false });
    try {
      const result = await callRating("queryRatingAnalysis", this.payload(targetPage));
      if (epoch !== this._requestEpoch) return;
      const summary = normalizeSummary(result.summary || EMPTY_SUMMARY);
      const actualPage = Math.max(1, Number(result.pageNumber || 1));
      this.setData({
        searched: true, orders: normalizeOrders(result.orders || []), summary,
        page: actualPage, pageJump: String(actualPage), total: Number(result.total || 0),
        totalPages: Math.max(1, Number(result.totalPages || 1))
      }, () => this.drawCharts(epoch));
      this.resetTableScroll();
    } catch (error) {
      if (epoch !== this._requestEpoch) return;
      this.setData({
        searched: true, orders: [], summary: normalizeSummary(EMPTY_SUMMARY), page: 1, pageJump: "1",
        total: 0, totalPages: 1, tableScrollLeft: 0,
        message: error.message || "评价分析读取失败", error: true
      });
    } finally {
      if (epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },

  resetSearch() {
    this.clearResults({
      storeIndex: 0, productIndex: 0, teacherIndex: 0,
      ...query.defaultTimeFilter(), selectedScores: [0, 1, 2, 3, 4, 5], scoreOptions: scoreOptions()
    });
  },

  resetTableScroll() {
    const epoch = Number(this._scrollResetEpoch || 0) + 1;
    this._scrollResetEpoch = epoch;
    this.setData({ tableScrollLeft: 1 }, () => {
      if (epoch === this._scrollResetEpoch) this.setData({ tableScrollLeft: 0 });
    });
  },

  previousPage() { if (!this.data.loading && this.data.page > 1) this.load(this.data.page - 1); },
  nextPage() { if (!this.data.loading && this.data.page < this.data.totalPages) this.load(this.data.page + 1); },
  inputPageJump(event) { this.setData({ pageJump: String(event.detail.value || "") }); },
  jumpPage() {
    const page = Number(this.data.pageJump);
    if (!Number.isInteger(page) || page < 1 || page > this.data.totalPages) {
      this.setData({ message: `请输入 1 到 ${this.data.totalPages} 的有效页码`, error: true });
      return;
    }
    this.load(page);
  },

  canvasNode(selector) {
    if (typeof wx.createSelectorQuery !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      wx.createSelectorQuery().in(this).select(selector).fields({ node: true, size: true }).exec((rows) => resolve(rows?.[0] || null));
    });
  },

  async drawPie(selector, segments, centerTop, centerBottom) {
    const target = await this.canvasNode(selector);
    if (!target?.node || !target.width || !target.height) return;
    const canvas = target.node;
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const ratio = Math.min(2, Number(windowInfo.pixelRatio || 1));
    canvas.width = Math.round(target.width * ratio);
    canvas.height = Math.round(target.height * ratio);
    const context = canvas.getContext("2d");
    context.scale(ratio, ratio);
    context.clearRect(0, 0, target.width, target.height);
    const centerX = target.width / 2;
    const centerY = target.height / 2;
    const radius = Math.min(target.width, target.height) * 0.43;
    const total = segments.reduce((sum, item) => sum + Number(item.count || 0), 0);
    let start = -Math.PI / 2;
    if (!total) {
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fillStyle = "#e3d8c8";
      context.fill();
    } else {
      segments.filter((item) => Number(item.count || 0) > 0).forEach((item) => {
        const end = start + Math.PI * 2 * Number(item.count || 0) / total;
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.arc(centerX, centerY, radius, start, end);
        context.closePath();
        context.fillStyle = item.color;
        context.fill();
        start = end;
      });
    }
    context.beginPath();
    context.arc(centerX, centerY, radius * 0.57, 0, Math.PI * 2);
    context.fillStyle = "#fffaf3";
    context.fill();
    context.fillStyle = "#302a22";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const centerTopSize = Math.max(16, radius * 0.29);
    const centerBottomSize = Math.max(11, radius * 0.18);
    context.font = `800 ${centerTopSize}px sans-serif`;
    context.fillText(centerTop, centerX, centerY - centerTopSize * 0.38);
    context.fillStyle = "#7c7062";
    context.font = `600 ${centerBottomSize}px sans-serif`;
    context.fillText(centerBottom, centerX, centerY + centerTopSize * 0.58);
  },

  async drawCharts(requestEpoch) {
    const chartEpoch = Number(this._chartEpoch || 0) + 1;
    this._chartEpoch = chartEpoch;
    await Promise.resolve();
    if (requestEpoch !== this._requestEpoch || chartEpoch !== this._chartEpoch) return;
    const summary = this.data.summary;
    await Promise.all([
      this.drawPie("#scoreDistributionChart", summary.scoreLegend || [], String(summary.rated || 0), "已评价"),
      this.drawPie("#ratingCoverageChart", summary.coverageLegend || [], summary.coveragePercent || "0.0%", "评价覆盖率")
    ]);
  },

  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  },
  openOrder(event) {
    const id = String(event.currentTarget.dataset.id || "");
    const code = String(event.currentTarget.dataset.code || "");
    const category = String(event.currentTarget.dataset.category || "NORMAL").toUpperCase();
    if (id) wx.navigateTo({ url: `/pages/order-detail/index?type=verification&category=${encodeURIComponent(category)}&recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}` });
  }
});

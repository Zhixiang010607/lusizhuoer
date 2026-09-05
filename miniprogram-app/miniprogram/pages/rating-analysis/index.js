const { callRating } = require("../../services/api");
const { requireSession } = require("../../services/session");
const {
  EXPORT_BATCH_SIZE,
  EXPORT_MAX_ROWS,
  createGroupedWorkbook,
  openWorkbook
} = require("../../services/grouped-table-export");
const { PDF_EXPORT_MAX_ROWS, createGroupedPdf, openPdf } = require("../../services/grouped-table-pdf");
const query = require("../../services/query-tools");

const PAGE_SIZE = 20;
const SCORE_COLORS = Object.freeze(["#b9aea0", "#a9554b", "#c87348", "#c39945", "#82905e", "#47745e"]);
const EMPTY_SUMMARY = Object.freeze({ total: 0, rated: 0, unrated: 0, scoreCounts: [0, 0, 0, 0, 0, 0] });

function labels(options) { return options.map((item) => item.label); }
function values(options) { return options.map((item) => item.value); }
function percentage(count, total) { return total > 0 ? `${(Number(count || 0) * 100 / total).toFixed(1)}%` : "0.0%"; }
function statusSuffix(status) { return String(status || "").toUpperCase() === "ARCHIVED" ? "（已封存）" : ""; }

function pieGradient(items = []) {
  const segments = items.filter((item) => Number(item.count || 0) > 0);
  const total = segments.reduce((sum, item) => sum + Number(item.count || 0), 0);
  if (!total) return "#e3d8c8";
  let cursor = 0;
  const stops = segments.map((item, index) => {
    const start = cursor;
    cursor = index === segments.length - 1 ? 100 : cursor + Number(item.count || 0) * 100 / total;
    return `${item.color} ${start.toFixed(4)}% ${cursor.toFixed(4)}%`;
  });
  return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

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
  const scoreLegend = ratedCounts.map((count, index) => ({
    score: index + 1,
    label: `${index + 1} 分`,
    count,
    percentage: percentage(count, rated),
    color: SCORE_COLORS[index + 1]
  }));
  const coverageLegend = [
    { label: "已评价", count: rated, percentage: percentage(rated, total), color: "#9b7335" },
    { label: "未评价", count: unrated, percentage: percentage(unrated, total), color: "#d8cbb8" }
  ];
  return {
    total, rated, unrated, scoreCounts: counts,
    coveragePercent: percentage(rated, total),
    scoreLegend,
    coverageLegend,
    scoreGradient: pieGradient(scoreLegend),
    coverageGradient: pieGradient(coverageLegend)
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
    session: {}, loading: false, exporting: false, searched: false, message: "", error: false, tableScrollLeft: 0,
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
    if (this.data.exporting) { wx.stopPullDownRefresh(); return; }
    const action = this.loadOptions().then(() => this.data.searched ? this.load(1) : undefined);
    action.finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this._exportEpoch = Number(this._exportEpoch || 0) + 1;
    this._optionEpoch = Number(this._optionEpoch || 0) + 1;
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
    this._exportEpoch = Number(this._exportEpoch || 0) + 1;
    this.setData({
      ...changes, loading: false, exporting: false, searched: false, orders: [], summary: normalizeSummary(EMPTY_SUMMARY),
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

  payload(page, pageSize = PAGE_SIZE) {
    const result = { pageNumber: page, pageSize, scores: this.data.selectedScores.slice() };
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
      });
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

  previousPage() { if (!this.data.loading && !this.data.exporting && this.data.page > 1) this.load(this.data.page - 1); },
  nextPage() { if (!this.data.loading && !this.data.exporting && this.data.page < this.data.totalPages) this.load(this.data.page + 1); },
  inputPageJump(event) { this.setData({ pageJump: String(event.detail.value || "") }); },
  jumpPage() {
    if (this.data.exporting) return;
    const page = Number(this.data.pageJump);
    if (!Number.isInteger(page) || page < 1 || page > this.data.totalPages) {
      this.setData({ message: `请输入 1 到 ${this.data.totalPages} 的有效页码`, error: true });
      return;
    }
    this.load(page);
  },

  selectedStoreName() {
    if (this.data.session.role !== "hq") return String(this.data.session.storeName || "本门店");
    if (this.data.storeIndex <= 0) return "全部门店";
    return String(this.data.stores[this.data.storeIndex - 1]?.name || "指定门店");
  },
  selectedProductName() {
    if (this.data.productIndex <= 0) return "全部项目";
    return String(this.data.products[this.data.productIndex - 1]?.name || "指定项目");
  },
  selectedTeacherName() {
    return String(this.data.teacherLabels[this.data.teacherIndex] || "全部老师");
  },
  exportCriteria(today, count) {
    const scoreText = this.data.selectedScores.map((score) => score === 0 ? "未评价" : `${score}分`).join("、");
    const coverage = this.data.summary.coveragePercent || "0.0%";
    const distribution = (this.data.summary.scoreLegend || []).map((item) => `${item.label}${item.count}单/${item.percentage}`).join("、");
    return `门店：${this.selectedStoreName()}｜项目：${this.selectedProductName()}｜老师：${this.selectedTeacherName()}｜时间：${this.data.startDate || "最早"} 至 ${this.data.endDate || "今天"}｜最低分：${scoreText}｜评价覆盖率：${coverage}｜1–5分分布：${distribution}｜导出日期：${today}｜共 ${count} 单`;
  },

  async collectAllOrders(expectedTotal, exportEpoch) {
    const uniqueRows = new Map();
    let pageNumber = 1;
    let totalPages = 1;
    do {
      const result = await callRating("queryRatingAnalysis", this.payload(pageNumber, EXPORT_BATCH_SIZE));
      if (exportEpoch !== this._exportEpoch) return [];
      if (Number(result.total || 0) !== expectedTotal) throw new Error("查询结果在导出期间发生变化，请重新查询后再导出");
      totalPages = Math.max(1, Number(result.totalPages || 1));
      for (const row of normalizeOrders(result.orders || [])) uniqueRows.set(row.rowKey, row);
      if (uniqueRows.size > EXPORT_MAX_ROWS) throw new Error(`单次最多导出 ${EXPORT_MAX_ROWS} 条，请缩小查询范围`);
      this.setData({ message: `正在准备导出 ${Math.min(uniqueRows.size, expectedTotal)} / ${expectedTotal} 单…`, error: false });
      pageNumber += 1;
    } while (pageNumber <= totalPages);
    const rows = [...uniqueRows.values()];
    if (rows.length !== expectedTotal) throw new Error("查询结果在导出期间发生变化，请重新查询后再导出");
    return rows;
  },

  async exportAll(format = "excel") {
    const expectedTotal = Number(this.data.total || 0);
    if (!this.data.searched || this.data.loading || this.data.exporting || expectedTotal <= 0) return;
    const exportLimit = format === "pdf" ? PDF_EXPORT_MAX_ROWS : EXPORT_MAX_ROWS;
    if (expectedTotal > exportLimit) {
      this.setData({ message: `当前结果有 ${expectedTotal} 单，单次最多导出 ${exportLimit} 单，请缩小查询范围`, error: true });
      return;
    }
    const exportEpoch = Number(this._exportEpoch || 0) + 1;
    this._exportEpoch = exportEpoch;
    this.setData({ exporting: true, message: `正在准备导出 0 / ${expectedTotal} 单…`, error: false });
    try {
      const rows = await this.collectAllOrders(expectedTotal, exportEpoch);
      if (exportEpoch !== this._exportEpoch) return;
      const today = query.businessToday();
      const reportOptions = {
        title: "评价分析查询结果", sheetName: "评价分析",
        criteria: this.exportCriteria(today, rows.length), rows,
        groupKey: (row) => row.storeId || row.storeName,
        groupLabel: (row) => row.storeName,
        columns: [
          { key: "recordCode", header: "工单号", width: 22 },
          { key: "customerName", header: "客户", width: 18 },
          { key: "storeName", header: "门店", width: 18 },
          { key: "productName", header: "项目", width: 18 },
          { key: "teacherName", header: "老师", width: 16 },
          { key: "serviceTime", header: "服务时间", width: 20 },
          { key: "effectiveScoreLabel", header: "最低分", width: 11 },
          { key: "storeScoreLabel", header: "门店环境", width: 11 },
          { key: "teacherScoreLabel", header: "老师服务", width: 11 },
          { key: "overallScoreLabel", header: "整体体验", width: 11 }
        ]
      };
      const report = format === "pdf" ? createGroupedPdf(reportOptions) : createGroupedWorkbook(reportOptions);
      if (format === "pdf") await openPdf({ bytes: report.bytes, filename: `评价分析-${today}` });
      else await openWorkbook({ bytes: report.bytes, filename: `评价分析-${today}` });
      if (exportEpoch === this._exportEpoch) this.setData({ message: `已导出 ${report.rowCount} 单的 ${format === "pdf" ? "PDF" : "Excel"}，并按 ${report.groupCount} 个门店分组`, error: false });
    } catch (error) {
      if (exportEpoch !== this._exportEpoch) return;
      const cancelled = /cancel/i.test(String(error && (error.errMsg || error.message) || ""));
      this.setData({ message: cancelled ? `已取消打开 ${format === "pdf" ? "PDF" : "Excel"}` : error.message || error.errMsg || "评价分析导出失败", error: !cancelled });
    } finally {
      if (exportEpoch === this._exportEpoch) this.setData({ exporting: false });
    }
  },

  exportExcel() { return this.exportAll("excel"); },
  exportPdf() { return this.exportAll("pdf"); },

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

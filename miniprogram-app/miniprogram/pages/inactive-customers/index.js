const { callFace, callStaff } = require("../../services/api");
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
const CATEGORIES = Object.freeze(["ZERO", "NONZERO"]);
const EMPTY_SUMMARY = Object.freeze({
  selectedTotal: 0,
  categoryTotal: 0,
  zeroBalanceCustomers: 0,
  nonzeroBalanceCustomers: 0,
  normalBaseline: 0,
  experienceBaseline: 0,
  neverVerified: 0
});

function prefixFor(category) { return category === "ZERO" ? "zero" : "nonzero"; }
function categoryLabel(category) { return category === "ZERO" ? "全部项目为 0" : "任意项目非 0"; }

function sourceLabel(value) {
  return ({ NORMAL: "正常核销", EXPERIENCE: "体验核销", CUSTOMER_CREATED: "客户建档" })[
    String(value || "").toUpperCase()
  ] || "客户建档";
}

function customerRows(rows = []) {
  return rows.map((item) => {
    const baselineSource = String(item.baselineSource || "CUSTOMER_CREATED").toUpperCase();
    const balanceCategory = String(item.balanceCategory || "ZERO").toUpperCase();
    return {
      ...item,
      customerCode: String(item.customerCode || ""),
      customerName: String(item.customerName || "—"),
      storeName: String(item.storeName || "—"),
      balanceCategory,
      categoryLabel: categoryLabel(balanceCategory),
      baselineSourceLabel: sourceLabel(baselineSource),
      lastVerificationLabel: baselineSource === "CUSTOMER_CREATED"
        ? "从未核销"
        : query.displayDateTimeAny(item.baselineAt, item.baseline_at),
      daysSince: Number(item.daysSince || 0)
    };
  });
}

function emptyCategoryPatch(prefix) {
  return {
    [`${prefix}Customers`]: [], [`${prefix}Page`]: 1, [`${prefix}Total`]: 0,
    [`${prefix}TotalPages`]: 1, [`${prefix}PageJump`]: "1",
    [`${prefix}CursorStack`]: [null], [`${prefix}NextCursor`]: null,
    [`${prefix}TableScrollLeft`]: 0
  };
}

Page({
  data: {
    session: {}, loading: false, exporting: false, searched: false, message: "", error: false,
    minimumDays: "", summary: { ...EMPTY_SUMMARY }, total: 0, pageSize: PAGE_SIZE,
    zeroCustomers: [], zeroPage: 1, zeroTotal: 0, zeroTotalPages: 1, zeroPageJump: "1",
    zeroCursorStack: [null], zeroNextCursor: null, zeroTableScrollLeft: 0,
    nonzeroCustomers: [], nonzeroPage: 1, nonzeroTotal: 0, nonzeroTotalPages: 1, nonzeroPageJump: "1",
    nonzeroCursorStack: [null], nonzeroNextCursor: null, nonzeroTableScrollLeft: 0,
    stores: [], storeLabels: ["全部门店"], storeIndex: 0
  },

  async onLoad() {
    const session = requireSession(["hq", "store"]);
    if (!session) return;
    this.setData({ session });
    if (session.role === "hq") await this.loadStores();
  },

  onPullDownRefresh() {
    if (this.data.exporting) { wx.stopPullDownRefresh(); return; }
    const action = this.data.searched ? this.loadBoth() : Promise.resolve();
    action.finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this._exportEpoch = Number(this._exportEpoch || 0) + 1;
    this._scrollResetEpoch = Number(this._scrollResetEpoch || 0) + 1;
  },

  async loadStores() {
    try {
      const result = await callStaff("listStores");
      const stores = (result.stores || []).map((store) => ({
        id: String(store.id || store.store_id || ""),
        name: String(store.store_name || store.storeName || "未命名门店"),
        label: [store.store_name || store.storeName || "未命名门店", store.store_code || store.storeCode || ""].filter(Boolean).join(" · ")
      })).filter((store) => store.id);
      this.setData({ stores, storeLabels: ["全部门店", ...stores.map((store) => store.label)] });
    } catch (error) {
      this.setData({ message: error.message || "门店范围读取失败", error: true });
    }
  },

  resetTableScroll(category) {
    const prefix = prefixFor(category);
    const epoch = Number(this._scrollResetEpoch || 0) + 1;
    this._scrollResetEpoch = epoch;
    this.setData({ [`${prefix}TableScrollLeft`]: 1 }, () => {
      if (epoch === this._scrollResetEpoch) this.setData({ [`${prefix}TableScrollLeft`]: 0 });
    });
  },

  resetBothTableScroll() {
    const epoch = Number(this._scrollResetEpoch || 0) + 1;
    this._scrollResetEpoch = epoch;
    this.setData({ zeroTableScrollLeft: 1, nonzeroTableScrollLeft: 1 }, () => {
      if (epoch === this._scrollResetEpoch) this.setData({ zeroTableScrollLeft: 0, nonzeroTableScrollLeft: 0 });
    });
  },

  clearResults(changes = {}) {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this._exportEpoch = Number(this._exportEpoch || 0) + 1;
    this.setData({
      ...changes, loading: false, exporting: false, searched: false,
      summary: { ...EMPTY_SUMMARY }, total: 0,
      ...emptyCategoryPatch("zero"), ...emptyCategoryPatch("nonzero"),
      message: "", error: false
    });
  },

  chooseStore(event) { this.clearResults({ storeIndex: Number(event.detail.value) }); },
  inputMinimumDays(event) { this.clearResults({ minimumDays: String(event.detail.value || "") }); },

  basePayload(limit = PAGE_SIZE) {
    const payload = { minimumDays: String(this.data.minimumDays || "").trim(), limit };
    if (this.data.session.role === "hq" && this.data.storeIndex > 0) {
      payload.storeId = this.data.stores[this.data.storeIndex - 1]?.id || "";
    }
    return payload;
  },

  fetchPage(category, cursor, basePayload) {
    const payload = { ...basePayload, balanceCategory: category };
    if (cursor) {
      payload.cursorBaselineAt = cursor.baselineAt;
      payload.cursorCustomerId = cursor.customerId;
    }
    return callFace("queryInactiveVerificationCustomers", payload);
  },

  async resolveCategoryPage(category, targetPage, epoch, basePayload) {
    const prefix = prefixFor(category);
    const stack = targetPage === 1 ? [null] : this.data[`${prefix}CursorStack`]?.length
      ? this.data[`${prefix}CursorStack`].slice()
      : [null];
    while (targetPage > 1 && !stack[targetPage - 1]) {
      const pageToDiscover = stack.length;
      const intermediate = await this.fetchPage(category, stack[pageToDiscover - 1] || null, basePayload);
      if (epoch !== this._requestEpoch) return null;
      if (!intermediate.hasMore || !intermediate.nextCursor) break;
      stack[pageToDiscover] = intermediate.nextCursor;
    }
    if (targetPage > 1 && !stack[targetPage - 1]) throw new Error("目标页已超出当前查询结果");
    const result = await this.fetchPage(category, stack[targetPage - 1] || null, basePayload);
    if (epoch !== this._requestEpoch) return null;
    if (result.hasMore && result.nextCursor) stack[targetPage] = result.nextCursor;
    else stack.splice(targetPage);
    const summary = result.summary || { ...EMPTY_SUMMARY };
    const categoryTotal = Number(summary.categoryTotal || 0);
    const totalPages = Math.max(1, Math.ceil(categoryTotal / PAGE_SIZE));
    if (targetPage > totalPages && categoryTotal > 0) throw new Error(`请输入 1 到 ${totalPages} 的有效页码`);
    return { rows: customerRows(result.customers || []), summary, categoryTotal, totalPages, stack, nextCursor: result.nextCursor || null };
  },

  categoryPatch(category, targetPage, state) {
    const prefix = prefixFor(category);
    return {
      [`${prefix}Customers`]: state.rows, [`${prefix}Page`]: targetPage,
      [`${prefix}Total`]: state.categoryTotal, [`${prefix}TotalPages`]: state.totalPages,
      [`${prefix}PageJump`]: String(targetPage), [`${prefix}CursorStack`]: state.stack,
      [`${prefix}NextCursor`]: state.nextCursor
    };
  },

  firstPageState(category, result) {
    const section = result.sections?.[category];
    if (!section || !Array.isArray(section.customers)) {
      throw new Error("活跃预警服务版本过旧，请先部署最新云函数");
    }
    const summary = result.summary || { ...EMPTY_SUMMARY };
    const categoryTotal = Number(section.categoryTotal || 0);
    const totalPages = Math.max(1, Math.ceil(categoryTotal / PAGE_SIZE));
    const stack = [null];
    if (section.hasMore && section.nextCursor) stack[1] = section.nextCursor;
    return {
      rows: customerRows(section.customers), summary, categoryTotal, totalPages,
      stack, nextCursor: section.nextCursor || null
    };
  },

  async loadBoth() {
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const basePayload = this.basePayload();
    this.setData({ loading: true, message: "", error: false });
    try {
      const result = await this.fetchPage("BOTH", null, basePayload);
      if (epoch !== this._requestEpoch) return;
      const zeroState = this.firstPageState("ZERO", result);
      const nonzeroState = this.firstPageState("NONZERO", result);
      const summary = result.summary || { ...EMPTY_SUMMARY };
      this.setData({
        searched: true, summary, total: Number(summary.selectedTotal || 0),
        ...this.categoryPatch("ZERO", 1, zeroState),
        ...this.categoryPatch("NONZERO", 1, nonzeroState)
      }, () => this.resetBothTableScroll());
    } catch (error) {
      if (epoch !== this._requestEpoch) return;
      this.setData({
        searched: true, summary: { ...EMPTY_SUMMARY }, total: 0,
        ...emptyCategoryPatch("zero"), ...emptyCategoryPatch("nonzero"),
        message: error.message || "活跃预警读取失败", error: true
      });
    } finally {
      if (epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },

  async loadCategory(category, targetPage) {
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    this.setData({ loading: true, message: "", error: false });
    try {
      const state = await this.resolveCategoryPage(category, targetPage, epoch, this.basePayload());
      if (epoch !== this._requestEpoch || !state) return;
      this.setData({
        searched: true, summary: state.summary, total: Number(state.summary.selectedTotal || 0),
        ...this.categoryPatch(category, targetPage, state)
      }, () => this.resetTableScroll(category));
    } catch (error) {
      if (epoch === this._requestEpoch) this.setData({ message: error.message || "活跃预警读取失败", error: true });
    } finally {
      if (epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },

  search() {
    const value = String(this.data.minimumDays || "").trim();
    const days = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(days) || days < 1 || days > 3650) {
      this.setData({ message: "请输入 1 至 3650 的整数天数", error: true });
      return;
    }
    this.setData({ ...emptyCategoryPatch("zero"), ...emptyCategoryPatch("nonzero") });
    this.loadBoth();
  },

  resetSearch() { this.clearResults({ minimumDays: "", storeIndex: 0 }); },
  previousPage(event) {
    const category = String(event.currentTarget.dataset.category || "").toUpperCase();
    const prefix = prefixFor(category);
    const page = Number(this.data[`${prefix}Page`] || 1);
    if (CATEGORIES.includes(category) && !this.data.loading && !this.data.exporting && page > 1) this.loadCategory(category, page - 1);
  },
  nextPage(event) {
    const category = String(event.currentTarget.dataset.category || "").toUpperCase();
    const prefix = prefixFor(category);
    const page = Number(this.data[`${prefix}Page`] || 1);
    const totalPages = Number(this.data[`${prefix}TotalPages`] || 1);
    if (CATEGORIES.includes(category) && !this.data.loading && !this.data.exporting && page < totalPages) this.loadCategory(category, page + 1);
  },
  inputPageJump(event) {
    const category = String(event.currentTarget.dataset.category || "").toUpperCase();
    if (CATEGORIES.includes(category)) this.setData({ [`${prefixFor(category)}PageJump`]: String(event.detail.value || "") });
  },
  jumpPage(event) {
    if (this.data.loading || this.data.exporting) return;
    const category = String(event.currentTarget.dataset.category || "").toUpperCase();
    if (!CATEGORIES.includes(category)) return;
    const prefix = prefixFor(category);
    const page = Number(this.data[`${prefix}PageJump`]);
    const totalPages = Number(this.data[`${prefix}TotalPages`] || 1);
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      this.setData({ message: `请输入 1 到 ${totalPages} 的有效页码`, error: true });
      return;
    }
    this.loadCategory(category, page);
  },

  selectedStoreName() {
    if (this.data.session.role !== "hq") return String(this.data.session.storeName || "本门店");
    if (this.data.storeIndex <= 0) return "全部门店";
    return String(this.data.stores[this.data.storeIndex - 1]?.name || "指定门店");
  },

  async collectExportSnapshot(expectedTotal, exportEpoch) {
    const result = await this.fetchPage("BOTH", null, { ...this.basePayload(EXPORT_BATCH_SIZE), exportAll: true });
    if (exportEpoch !== this._exportEpoch) return [];
    const snapshotTotal = Number(result.summary?.selectedTotal || 0);
    if (snapshotTotal !== expectedTotal) throw new Error("查询结果在导出前发生变化，请重新查询后再导出");
    const rows = customerRows(result.exportCustomers || []);
    if (rows.length !== snapshotTotal) throw new Error("完整导出结果校验失败，请重新查询后再导出");
    const uniqueRows = new Map(rows.map((row) => [row.customerCode, row]));
    if (uniqueRows.size !== rows.length) throw new Error("完整导出出现重复客户，请重新查询后再导出");
    return [...uniqueRows.values()];
  },

  async exportAll(format = "excel") {
    const expectedTotal = Number(this.data.total || 0);
    if (!this.data.searched || this.data.loading || this.data.exporting || expectedTotal <= 0) return;
    const exportLimit = format === "pdf" ? PDF_EXPORT_MAX_ROWS : EXPORT_MAX_ROWS;
    if (expectedTotal > exportLimit) {
      this.setData({ message: `当前结果有 ${expectedTotal} 位，单次最多导出 ${exportLimit} 位，请缩小查询范围`, error: true });
      return;
    }
    const exportEpoch = Number(this._exportEpoch || 0) + 1;
    this._exportEpoch = exportEpoch;
    this.setData({ exporting: true, message: `正在准备导出 0 / ${expectedTotal} 位…`, error: false });
    try {
      const rows = await this.collectExportSnapshot(expectedTotal, exportEpoch);
      if (exportEpoch !== this._exportEpoch) return;
      const today = query.businessToday();
      const reportOptions = {
        title: "活跃预警查询结果", sheetName: "活跃预警",
        criteria: `查询条件：核销间隔至少 ${String(this.data.minimumDays).trim()} 天｜门店范围：${this.selectedStoreName()}｜导出日期：${today}｜共 ${rows.length} 位客户`,
        rows, groupKey: (row) => row.storeId || row.storeName, groupLabel: (row) => row.storeName,
        columns: [
          { key: "categoryLabel", header: "预警分类", width: 18 },
          { key: "customerName", header: "客户", width: 22 },
          { key: "storeName", header: "门店", width: 20 },
          { key: "daysSince", header: "间隔时间（天）", width: 16, type: "number" },
          { key: "baselineSourceLabel", header: "计算起点", width: 15 },
          { key: "lastVerificationLabel", header: "上次核销", width: 21 }
        ]
      };
      const report = format === "pdf" ? createGroupedPdf(reportOptions) : createGroupedWorkbook(reportOptions);
      if (format === "pdf") await openPdf({ bytes: report.bytes, filename: `活跃预警-${today}` });
      else await openWorkbook({ bytes: report.bytes, filename: `活跃预警-${today}` });
      if (exportEpoch === this._exportEpoch) this.setData({ message: `已导出 ${report.rowCount} 位客户的 ${format === "pdf" ? "PDF" : "Excel"}，并按 ${report.groupCount} 个门店分组`, error: false });
    } catch (error) {
      if (exportEpoch !== this._exportEpoch) return;
      const cancelled = /cancel/i.test(String(error && (error.errMsg || error.message) || ""));
      this.setData({ message: cancelled ? `已取消打开 ${format === "pdf" ? "PDF" : "Excel"}` : error.message || error.errMsg || "活跃预警导出失败", error: !cancelled });
    } finally {
      if (exportEpoch === this._exportEpoch) this.setData({ exporting: false });
    }
  },

  exportExcel() { return this.exportAll("excel"); },
  exportPdf() { return this.exportAll("pdf"); },

  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  }
});

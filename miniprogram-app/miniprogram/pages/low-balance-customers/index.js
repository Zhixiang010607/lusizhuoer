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
  customerTotal: 0,
  productTotal: 0,
  zeroBalance: 0,
  nonzeroBelowThreshold: 0
});

function prefixFor(category) { return category === "ZERO" ? "zero" : "nonzero"; }
function categoryLabel(category) { return category === "ZERO" ? "项目余次为 0" : "非 0 且低于阈值"; }

function balanceRows(rows = []) {
  return rows.map((item) => {
    const balanceCategory = String(item.balanceCategory || (Number(item.remainingCount || 0) === 0 ? "ZERO" : "NONZERO")).toUpperCase();
    return {
      ...item,
      rowKey: `${String(item.customerCode || "")}-${String(item.productId || "")}`,
      customerCode: String(item.customerCode || ""),
      customerName: String(item.customerName || "—"),
      storeName: String(item.storeName || "—"),
      productName: String(item.productName || "—"),
      purchasedCount: Number(item.purchasedCount || 0),
      consumedCount: Number(item.consumedCount || 0),
      remainingCount: Number(item.remainingCount || 0),
      balanceCategory,
      categoryLabel: categoryLabel(balanceCategory)
    };
  });
}

function emptyCategoryPatch(prefix) {
  return {
    [`${prefix}Balances`]: [], [`${prefix}Page`]: 1, [`${prefix}Total`]: 0,
    [`${prefix}TotalPages`]: 1, [`${prefix}PageJump`]: "1",
    [`${prefix}CursorStack`]: [null], [`${prefix}NextCursor`]: null,
    [`${prefix}TableScrollLeft`]: 0
  };
}

Page({
  data: {
    session: {}, loading: false, exporting: false, searched: false, message: "", error: false,
    remainingBelow: "", summary: { ...EMPTY_SUMMARY }, total: 0, pageSize: PAGE_SIZE,
    zeroBalances: [], zeroPage: 1, zeroTotal: 0, zeroTotalPages: 1, zeroPageJump: "1",
    zeroCursorStack: [null], zeroNextCursor: null, zeroTableScrollLeft: 0,
    nonzeroBalances: [], nonzeroPage: 1, nonzeroTotal: 0, nonzeroTotalPages: 1, nonzeroPageJump: "1",
    nonzeroCursorStack: [null], nonzeroNextCursor: null, nonzeroTableScrollLeft: 0,
    stores: [], storeLabels: ["全部门店"], storeIndex: 0,
    products: [], productLabels: ["全部项目"], productIndex: 0
  },

  async onLoad() {
    const session = requireSession(["hq", "store"]);
    if (!session) return;
    this.setData({ session });
    const tasks = [this.loadProducts()];
    if (session.role === "hq") tasks.push(this.loadStores());
    await Promise.all(tasks);
  },

  onPullDownRefresh() {
    if (this.data.exporting) { wx.stopPullDownRefresh(); return; }
    const action = this.data.searched ? this.loadBoth() : Promise.all([
      this.loadProducts(),
      this.data.session.role === "hq" ? this.loadStores() : Promise.resolve()
    ]);
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

  async loadProducts() {
    try {
      const result = await callStaff("listProducts");
      const products = (result.products || []).map((product) => ({
        id: String(product.id || product.product_id || ""),
        name: String(product.product_name || product.productName || "未命名项目"),
        status: String(product.product_status || product.productStatus || "ACTIVE").toUpperCase()
      })).filter((product) => product.id && product.status === "ACTIVE");
      this.setData({ products, productLabels: ["全部项目", ...products.map((product) => product.name)] });
    } catch (error) {
      this.setData({ message: error.message || "项目列表读取失败", error: true });
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
  chooseProduct(event) { this.clearResults({ productIndex: Number(event.detail.value) }); },
  inputRemainingBelow(event) { this.clearResults({ remainingBelow: String(event.detail.value || "") }); },

  basePayload(limit = PAGE_SIZE) {
    const payload = { remainingBelow: String(this.data.remainingBelow || "").trim(), limit };
    if (this.data.session.role === "hq" && this.data.storeIndex > 0) {
      payload.storeId = this.data.stores[this.data.storeIndex - 1]?.id || "";
    }
    if (this.data.productIndex > 0) payload.productId = this.data.products[this.data.productIndex - 1]?.id || "";
    return payload;
  },

  fetchPage(category, cursor, basePayload) {
    const payload = { ...basePayload, balanceCategory: category };
    if (cursor) {
      payload.cursorRemainingCount = cursor.remainingCount;
      payload.cursorCustomerId = cursor.customerId;
      payload.cursorProductId = cursor.productId;
    }
    return callFace("queryLowBalanceCustomers", payload);
  },

  async resolveCategoryPage(category, targetPage, epoch, basePayload) {
    const prefix = prefixFor(category);
    const stack = targetPage === 1 ? [null]
      : this.data[`${prefix}CursorStack`]?.length ? this.data[`${prefix}CursorStack`].slice() : [null];
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
    return { rows: balanceRows(result.balances || []), summary, categoryTotal, totalPages, stack, nextCursor: result.nextCursor || null };
  },

  categoryPatch(category, targetPage, state) {
    const prefix = prefixFor(category);
    return {
      [`${prefix}Balances`]: state.rows, [`${prefix}Page`]: targetPage,
      [`${prefix}Total`]: state.categoryTotal, [`${prefix}TotalPages`]: state.totalPages,
      [`${prefix}PageJump`]: String(targetPage), [`${prefix}CursorStack`]: state.stack,
      [`${prefix}NextCursor`]: state.nextCursor
    };
  },

  async loadBoth() {
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const basePayload = this.basePayload();
    this.setData({ loading: true, message: "", error: false });
    try {
      const [zeroState, nonzeroState] = await Promise.all([
        this.resolveCategoryPage("ZERO", 1, epoch, basePayload),
        this.resolveCategoryPage("NONZERO", 1, epoch, basePayload)
      ]);
      if (epoch !== this._requestEpoch || !zeroState || !nonzeroState) return;
      const summary = zeroState.summary;
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
        message: error.message || "余次预警读取失败", error: true
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
      if (epoch === this._requestEpoch) this.setData({ message: error.message || "余次预警读取失败", error: true });
    } finally {
      if (epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },

  search() {
    const value = String(this.data.remainingBelow || "").trim();
    const count = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(count) || count < 1 || count > 999999) {
      this.setData({ message: "请输入 1 至 999999 的整数次数", error: true });
      return;
    }
    this.setData({ ...emptyCategoryPatch("zero"), ...emptyCategoryPatch("nonzero") });
    this.loadBoth();
  },

  resetSearch() { this.clearResults({ remainingBelow: "", storeIndex: 0, productIndex: 0 }); },
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
  selectedProductName() {
    if (this.data.productIndex <= 0) return "全部项目";
    return String(this.data.products[this.data.productIndex - 1]?.name || "指定项目");
  },

  async collectCategory(category, expectedCategoryTotal, expectedTotal, basePayload, exportEpoch, uniqueRows) {
    const seenCursors = new Set();
    let cursor = null;
    while (true) {
      const result = await this.fetchPage(category, cursor, basePayload);
      if (exportEpoch !== this._exportEpoch) return;
      if (Number(result.summary?.selectedTotal || 0) !== expectedTotal
          || Number(result.summary?.categoryTotal || 0) !== expectedCategoryTotal) {
        throw new Error("查询结果在导出期间发生变化，请重新查询后再导出");
      }
      for (const row of balanceRows(result.balances || [])) uniqueRows.set(row.rowKey, row);
      if (uniqueRows.size > EXPORT_MAX_ROWS) throw new Error(`单次最多导出 ${EXPORT_MAX_ROWS} 条，请缩小查询范围`);
      this.setData({ message: `正在准备导出 ${Math.min(uniqueRows.size, expectedTotal)} / ${expectedTotal} 个卡项…`, error: false });
      if (!result.hasMore) break;
      if (!result.nextCursor) throw new Error("导出游标缺失，请重新查询后再试");
      const fingerprint = JSON.stringify(result.nextCursor);
      if (seenCursors.has(fingerprint)) throw new Error("导出游标重复，请重新查询后再试");
      seenCursors.add(fingerprint);
      cursor = result.nextCursor;
    }
  },

  async exportAll(format = "excel") {
    const expectedTotal = Number(this.data.total || 0);
    if (!this.data.searched || this.data.loading || this.data.exporting || expectedTotal <= 0) return;
    const exportLimit = format === "pdf" ? PDF_EXPORT_MAX_ROWS : EXPORT_MAX_ROWS;
    if (expectedTotal > exportLimit) {
      this.setData({ message: `当前结果有 ${expectedTotal} 个卡项，单次最多导出 ${exportLimit} 个，请缩小查询范围`, error: true });
      return;
    }
    const exportEpoch = Number(this._exportEpoch || 0) + 1;
    this._exportEpoch = exportEpoch;
    const basePayload = this.basePayload(EXPORT_BATCH_SIZE);
    const uniqueRows = new Map();
    this.setData({ exporting: true, message: `正在准备导出 0 / ${expectedTotal} 个卡项…`, error: false });
    try {
      await this.collectCategory("ZERO", Number(this.data.zeroTotal || 0), expectedTotal, basePayload, exportEpoch, uniqueRows);
      await this.collectCategory("NONZERO", Number(this.data.nonzeroTotal || 0), expectedTotal, basePayload, exportEpoch, uniqueRows);
      if (exportEpoch !== this._exportEpoch) return;
      const rows = [...uniqueRows.values()];
      if (rows.length !== expectedTotal) throw new Error("查询结果在导出期间发生变化，请重新查询后再导出");
      const today = query.businessToday();
      const reportOptions = {
        title: "余次预警查询结果", sheetName: "余次预警",
        criteria: `查询条件：${this.selectedProductName()}剩余次数严格低于 ${String(this.data.remainingBelow).trim()} 次｜门店范围：${this.selectedStoreName()}｜导出日期：${today}｜共 ${rows.length} 个卡项`,
        rows, groupKey: (row) => row.storeId || row.storeName, groupLabel: (row) => row.storeName,
        columns: [
          { key: "categoryLabel", header: "预警分类", width: 18 },
          { key: "customerName", header: "姓名", width: 22 },
          { key: "productName", header: "项目", width: 20 },
          { key: "remainingCount", header: "当前剩余", width: 14, type: "number" },
          { key: "purchasedCount", header: "净开卡", width: 14, type: "number" },
          { key: "consumedCount", header: "已核销", width: 14, type: "number" },
          { key: "storeName", header: "门店", width: 20 }
        ]
      };
      const report = format === "pdf" ? createGroupedPdf(reportOptions) : createGroupedWorkbook(reportOptions);
      if (format === "pdf") await openPdf({ bytes: report.bytes, filename: `余次预警-${today}` });
      else await openWorkbook({ bytes: report.bytes, filename: `余次预警-${today}` });
      if (exportEpoch === this._exportEpoch) this.setData({ message: `已导出 ${report.rowCount} 个卡项的 ${format === "pdf" ? "PDF" : "Excel"}，并按 ${report.groupCount} 个门店分组`, error: false });
    } catch (error) {
      if (exportEpoch !== this._exportEpoch) return;
      const cancelled = /cancel/i.test(String(error && (error.errMsg || error.message) || ""));
      this.setData({ message: cancelled ? `已取消打开 ${format === "pdf" ? "PDF" : "Excel"}` : error.message || error.errMsg || "余次预警导出失败", error: !cancelled });
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

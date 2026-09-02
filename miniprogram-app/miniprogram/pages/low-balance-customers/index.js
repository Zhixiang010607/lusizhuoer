const { callFace, callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const {
  EXPORT_BATCH_SIZE,
  EXPORT_MAX_ROWS,
  createGroupedWorkbook,
  openWorkbook
} = require("../../services/grouped-table-export");
const query = require("../../services/query-tools");

const PAGE_SIZE = 20;
const EMPTY_SUMMARY = Object.freeze({ selectedTotal: 0, customerTotal: 0, productTotal: 0, zeroBalance: 0 });

function balanceRows(rows = []) {
  return rows.map((item) => ({
    ...item,
    rowKey: `${String(item.customerCode || "")}-${String(item.productId || "")}`,
    customerCode: String(item.customerCode || ""),
    customerName: String(item.customerName || "—"),
    storeName: String(item.storeName || "—"),
    productName: String(item.productName || "—"),
    purchasedCount: Number(item.purchasedCount || 0),
    consumedCount: Number(item.consumedCount || 0),
    remainingCount: Number(item.remainingCount || 0)
  }));
}

Page({
  data: {
    session: {}, loading: false, exporting: false, searched: false, message: "", error: false, tableScrollLeft: 0,
    remainingBelow: "", balances: [], summary: { ...EMPTY_SUMMARY },
    page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1, pageJump: "1",
    cursorStack: [null], nextCursor: null,
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
    const action = this.data.searched ? this.load(1) : Promise.all([
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
      this.setData({
        products,
        productLabels: ["全部项目", ...products.map((product) => product.name)]
      });
    } catch (error) {
      this.setData({ message: error.message || "项目列表读取失败", error: true });
    }
  },

  resetTableScroll() {
    const epoch = Number(this._scrollResetEpoch || 0) + 1;
    this._scrollResetEpoch = epoch;
    this.setData({ tableScrollLeft: 1 }, () => {
      if (epoch === this._scrollResetEpoch) this.setData({ tableScrollLeft: 0 });
    });
  },

  clearResults(changes = {}) {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this._exportEpoch = Number(this._exportEpoch || 0) + 1;
    this.setData({
      ...changes, loading: false, exporting: false, searched: false, balances: [], summary: { ...EMPTY_SUMMARY },
      page: 1, total: 0, totalPages: 1, pageJump: "1", cursorStack: [null], nextCursor: null,
      tableScrollLeft: 0, message: "", error: false
    });
  },

  chooseStore(event) { this.clearResults({ storeIndex: Number(event.detail.value) }); },
  chooseProduct(event) { this.clearResults({ productIndex: Number(event.detail.value) }); },
  inputRemainingBelow(event) { this.clearResults({ remainingBelow: String(event.detail.value || "") }); },

  basePayload() {
    const payload = { remainingBelow: String(this.data.remainingBelow || "").trim(), limit: PAGE_SIZE };
    if (this.data.session.role === "hq" && this.data.storeIndex > 0) {
      payload.storeId = this.data.stores[this.data.storeIndex - 1]?.id || "";
    }
    if (this.data.productIndex > 0) payload.productId = this.data.products[this.data.productIndex - 1]?.id || "";
    return payload;
  },

  fetchPage(cursor, basePayload) {
    const payload = { ...basePayload };
    if (cursor) {
      payload.cursorRemainingCount = cursor.remainingCount;
      payload.cursorCustomerId = cursor.customerId;
      payload.cursorProductId = cursor.productId;
    }
    return callFace("queryLowBalanceCustomers", payload);
  },

  async loadScopedPage(targetPage, epoch, basePayload) {
    const stack = this.data.cursorStack.length ? this.data.cursorStack.slice() : [null];
    while (targetPage > 1 && !stack[targetPage - 1]) {
      const pageToDiscover = stack.length;
      const intermediate = await this.fetchPage(stack[pageToDiscover - 1] || null, basePayload);
      if (epoch !== this._requestEpoch) return false;
      if (!intermediate.hasMore || !intermediate.nextCursor) break;
      stack[pageToDiscover] = intermediate.nextCursor;
    }
    if (targetPage > 1 && !stack[targetPage - 1]) throw new Error("目标页已超出当前查询结果");
    const result = await this.fetchPage(stack[targetPage - 1] || null, basePayload);
    if (epoch !== this._requestEpoch) return false;
    if (result.hasMore && result.nextCursor) stack[targetPage] = result.nextCursor;
    else stack.splice(targetPage);
    const summary = result.summary || { ...EMPTY_SUMMARY };
    const total = Number(summary.selectedTotal || 0);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (targetPage > totalPages && total > 0) throw new Error(`请输入 1 到 ${totalPages} 的有效页码`);
    this.setData({
      searched: true, balances: balanceRows(result.balances || []), summary,
      page: targetPage, total, totalPages, pageJump: String(targetPage),
      cursorStack: stack, nextCursor: result.nextCursor || null
    }, () => this.resetTableScroll());
    return true;
  },

  async load(page = 1) {
    const targetPage = Math.max(1, Number(page) || 1);
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const basePayload = this.basePayload();
    this.setData({ loading: true, message: "", error: false });
    try {
      await this.loadScopedPage(targetPage, epoch, basePayload);
    } catch (error) {
      if (epoch !== this._requestEpoch) return;
      this.setData({
        searched: true, balances: [], summary: { ...EMPTY_SUMMARY }, page: 1, total: 0,
        totalPages: 1, pageJump: "1", cursorStack: [null], nextCursor: null,
        tableScrollLeft: 0, message: error.message || "余次预警读取失败", error: true
      });
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
    this.setData({ cursorStack: [null], nextCursor: null, page: 1, pageJump: "1" });
    this.load(1);
  },

  resetSearch() { this.clearResults({ remainingBelow: "", storeIndex: 0, productIndex: 0 }); },
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
  async exportAll() {
    const expectedTotal = Number(this.data.total || 0);
    if (!this.data.searched || this.data.loading || this.data.exporting || expectedTotal <= 0) return;
    if (expectedTotal > EXPORT_MAX_ROWS) {
      this.setData({ message: `当前结果有 ${expectedTotal} 条，单次最多导出 ${EXPORT_MAX_ROWS} 条，请缩小查询范围`, error: true });
      return;
    }
    const exportEpoch = Number(this._exportEpoch || 0) + 1;
    this._exportEpoch = exportEpoch;
    const basePayload = { ...this.basePayload(), limit: EXPORT_BATCH_SIZE };
    const uniqueRows = new Map();
    const seenCursors = new Set();
    let cursor = null;
    this.setData({ exporting: true, message: `正在准备导出 0 / ${expectedTotal} 条…`, error: false });
    try {
      while (true) {
        const result = await this.fetchPage(cursor, basePayload);
        if (exportEpoch !== this._exportEpoch) return;
        const currentTotal = Number(result.summary?.selectedTotal || 0);
        if (currentTotal !== expectedTotal) throw new Error("查询结果在导出期间发生变化，请重新查询后再导出");
        for (const row of balanceRows(result.balances || [])) uniqueRows.set(row.rowKey, row);
        if (uniqueRows.size > EXPORT_MAX_ROWS) throw new Error(`单次最多导出 ${EXPORT_MAX_ROWS} 条，请缩小查询范围`);
        this.setData({ message: `正在准备导出 ${Math.min(uniqueRows.size, expectedTotal)} / ${expectedTotal} 条…`, error: false });
        if (!result.hasMore) break;
        if (!result.nextCursor) throw new Error("导出游标缺失，请重新查询后再试");
        const fingerprint = JSON.stringify(result.nextCursor);
        if (seenCursors.has(fingerprint)) throw new Error("导出游标重复，请重新查询后再试");
        seenCursors.add(fingerprint);
        cursor = result.nextCursor;
      }
      const rows = [...uniqueRows.values()];
      if (rows.length !== expectedTotal) throw new Error("查询结果在导出期间发生变化，请重新查询后再导出");
      const today = query.businessToday();
      const report = createGroupedWorkbook({
        title: "余次预警查询结果",
        sheetName: "余次预警",
        criteria: `查询条件：${this.selectedProductName()}剩余次数严格低于 ${String(this.data.remainingBelow).trim()} 次｜门店范围：${this.selectedStoreName()}｜导出日期：${today}｜共 ${rows.length} 个卡项`,
        rows,
        groupKey: (row) => row.storeId || row.storeName,
        groupLabel: (row) => row.storeName,
        columns: [
          { key: "customerName", header: "姓名", width: 22 },
          { key: "productName", header: "项目", width: 20 },
          { key: "remainingCount", header: "当前剩余", width: 14, type: "number" },
          { key: "purchasedCount", header: "净开卡", width: 14, type: "number" },
          { key: "consumedCount", header: "已核销", width: 14, type: "number" },
          { key: "storeName", header: "门店", width: 20 }
        ]
      });
      await openWorkbook({ bytes: report.bytes, filename: `余次预警-${today}` });
      if (exportEpoch === this._exportEpoch) {
        this.setData({ message: `已导出 ${report.rowCount} 个卡项，并按 ${report.groupCount} 个门店分组`, error: false });
      }
    } catch (error) {
      if (exportEpoch !== this._exportEpoch) return;
      const cancelled = /cancel/i.test(String(error && (error.errMsg || error.message) || ""));
      this.setData({ message: cancelled ? "已取消打开 Excel" : error.message || error.errMsg || "余次预警导出失败", error: !cancelled });
    } finally {
      if (exportEpoch === this._exportEpoch) this.setData({ exporting: false });
    }
  },
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  }
});

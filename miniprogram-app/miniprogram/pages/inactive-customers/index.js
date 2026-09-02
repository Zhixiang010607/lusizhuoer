const { callFace, callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");

const PAGE_SIZE = 20;
const EMPTY_SUMMARY = Object.freeze({ selectedTotal: 0, normalBaseline: 0, experienceBaseline: 0, neverVerified: 0 });

function sourceLabel(value) {
  return ({
    NORMAL: "正常核销",
    EXPERIENCE: "体验核销",
    CUSTOMER_CREATED: "客户建档"
  })[String(value || "").toUpperCase()] || "客户建档";
}

function customerRows(rows = []) {
  return rows.map((item) => {
    const baselineSource = String(item.baselineSource || "CUSTOMER_CREATED").toUpperCase();
    return {
      ...item,
      customerCode: String(item.customerCode || ""),
      customerName: String(item.customerName || "—"),
      storeName: String(item.storeName || "—"),
      baselineSourceLabel: sourceLabel(baselineSource),
      lastVerificationLabel: baselineSource === "CUSTOMER_CREATED"
        ? "从未核销"
        : query.displayDateTimeAny(item.baselineAt, item.baseline_at),
      daysSince: Number(item.daysSince || 0)
    };
  });
}

Page({
  data: {
    session: {}, loading: false, searched: false, message: "", error: false, tableScrollLeft: 0,
    minimumDays: "", customers: [], summary: { ...EMPTY_SUMMARY },
    page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1, pageJump: "1",
    cursorStack: [null], nextCursor: null,
    stores: [], storeLabels: ["全部门店"], storeIndex: 0
  },

  async onLoad() {
    const session = requireSession(["hq", "store"]);
    if (!session) return;
    this.setData({ session });
    if (session.role === "hq") await this.loadStores();
  },

  onPullDownRefresh() {
    const action = this.data.searched ? this.load(1) : Promise.resolve();
    action.finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this._scrollResetEpoch = Number(this._scrollResetEpoch || 0) + 1;
  },

  async loadStores() {
    try {
      const result = await callStaff("listStores");
      const stores = (result.stores || []).map((store) => ({
        id: String(store.id || store.store_id || ""),
        label: [store.store_name || store.storeName || "未命名门店", store.store_code || store.storeCode || ""].filter(Boolean).join(" · ")
      })).filter((store) => store.id);
      this.setData({ stores, storeLabels: ["全部门店", ...stores.map((store) => store.label)] });
    } catch (error) {
      this.setData({ message: error.message || "门店范围读取失败", error: true });
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
    this.setData({
      ...changes, loading: false, searched: false, customers: [], summary: { ...EMPTY_SUMMARY },
      page: 1, total: 0, totalPages: 1, pageJump: "1", cursorStack: [null], nextCursor: null,
      tableScrollLeft: 0, message: "", error: false
    });
  },

  chooseStore(event) { this.clearResults({ storeIndex: Number(event.detail.value) }); },
  inputMinimumDays(event) { this.clearResults({ minimumDays: String(event.detail.value || "") }); },

  basePayload() {
    const payload = {
      minimumDays: String(this.data.minimumDays || "").trim(),
      limit: PAGE_SIZE
    };
    if (this.data.session.role === "hq" && this.data.storeIndex > 0) {
      payload.storeId = this.data.stores[this.data.storeIndex - 1]?.id || "";
    }
    return payload;
  },

  fetchPage(cursor, basePayload) {
    const payload = { ...basePayload };
    if (cursor) {
      payload.cursorBaselineAt = cursor.baselineAt;
      payload.cursorCustomerId = cursor.customerId;
    }
    return callFace("queryInactiveVerificationCustomers", payload);
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
      searched: true, customers: customerRows(result.customers || []), summary,
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
        searched: true, customers: [], summary: { ...EMPTY_SUMMARY }, page: 1, total: 0,
        totalPages: 1, pageJump: "1", cursorStack: [null], nextCursor: null,
        tableScrollLeft: 0, message: error.message || "未核销客户读取失败", error: true
      });
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
    this.setData({ cursorStack: [null], nextCursor: null, page: 1, pageJump: "1" });
    this.load(1);
  },

  resetSearch() { this.clearResults({ minimumDays: "", storeIndex: 0 }); },
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
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  }
});

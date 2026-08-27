const { callFace, callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");

const PAGE_SIZE = 20;
const EMPTY_SUMMARY = Object.freeze({ total: 0, selectedTotal: 0, active: 0, archived: 0, informationOnly: 0, rechargedNoConsumption: 0, rechargedWithConsumption: 0 });
function labels(options) { return options.map((item) => item.label); }
function values(options) { return options.map((item) => item.value); }
function processLabel(value) {
  return ({
    INFORMATION_ONLY: "有信息但没有充值",
    RECHARGED_NO_CONSUMPTION: "已充值但没有消费",
    RECHARGED_WITH_CONSUMPTION: "已充值并已有消费"
  })[String(value || "").toUpperCase()] || "—";
}
function customerRows(rows = []) {
  return rows.map((item) => ({
    ...item,
    customerCode: String(item.customerCode || ""), customerName: String(item.customerName || "—"),
    birthDate: query.displayDateAny(item.birthDate, item.birth_date), storeName: String(item.storeName || item.store_name || "—"),
    statusLabel: String(item.customerStatus || "").toUpperCase() === "ARCHIVED" ? "已封存" : "活跃",
    processLabel: processLabel(item.customerProcessStatus),
    rechargeCount: Number(item.totalRechargeCount !== undefined ? item.totalRechargeCount : item.rechargeCount || 0),
    verificationCount: Number(item.totalVerificationCount !== undefined ? item.totalVerificationCount : item.verificationCount || 0),
    createdAtLabel: query.displayDateAny(item.createdAt, item.created_at)
  }));
}

Page({
  data: {
    session: {}, loading: false, message: "", error: false, mode: "browse", tableScrollLeft: 0,
    customers: [], page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1, hasMore: false, pageJump: "1",
    cursorStack: [null], nextCursor: null,
    stores: [], storeLabels: ["全部门店"], storeIndex: 0,
    processLabels: labels(query.CUSTOMER_PROCESS_OPTIONS), processValues: values(query.CUSTOMER_PROCESS_OPTIONS), processIndex: 0,
    statusLabels: labels(query.CUSTOMER_STATUS_OPTIONS), statusValues: values(query.CUSTOMER_STATUS_OPTIONS), statusIndex: 0,
    timeLabels: labels(query.TIME_OPTIONS), timeValues: values(query.TIME_OPTIONS), timeIndex: 0,
    customRange: false, startDate: "", endDate: "", today: query.businessToday(),
    name: "", birthDate: "",
    summary: { ...EMPTY_SUMMARY }
  },

  async onLoad() {
    const session = requireSession(["hq", "store"]);
    if (!session) return;
    this.setData({ session });
    if (session.role === "hq") await this.loadStores();
    await this.load(1);
  },
  onPullDownRefresh() { this.resetPaging(); this.load(1).finally(() => wx.stopPullDownRefresh()); },
  onUnload() { this._requestEpoch = Number(this._requestEpoch || 0) + 1; },

  async loadStores() {
    try {
      const result = await callStaff("listStores");
      const stores = (result.stores || []).map((store) => ({
        id: String(store.id || store.store_id || ""),
        label: [store.store_name || store.storeName || "未命名门店", store.store_code || store.storeCode || ""].filter(Boolean).join(" · ")
      })).filter((store) => store.id);
      this.setData({ stores, storeLabels: ["全部门店", ...stores.map((store) => store.label)] });
    } catch (error) { this.setData({ message: error.message || "门店范围读取失败", error: true }); }
  },

  resetPaging() { this.setData({ page: 1, pageJump: "1", cursorStack: [null], nextCursor: null }); },
  scopedPayload(cursor = null, basePayload = null) {
    if (basePayload) {
      const payload = { ...basePayload };
      if (cursor) { payload.cursorCreatedAt = cursor.createdAt; payload.cursorId = cursor.id; }
      return payload;
    }
    const payload = { mode: this.data.mode, limit: PAGE_SIZE };
    if (this.data.session.role === "hq" && this.data.storeIndex > 0) payload.storeId = this.data.stores[this.data.storeIndex - 1]?.id || "";
    if (this.data.mode === "manual") {
      payload.name = String(this.data.name || "").trim();
      payload.birthDate = this.data.birthDate;
    } else {
      payload.processStatus = this.data.processValues[this.data.processIndex] || "ALL";
      payload.customerStatus = this.data.statusValues[this.data.statusIndex] || "ALL";
      payload.startDate = this.data.startDate;
      payload.endDate = this.data.endDate;
    }
    if (cursor) { payload.cursorCreatedAt = cursor.createdAt; payload.cursorId = cursor.id; }
    return payload;
  },
  fetchScoped(cursor, basePayload) { return callFace("queryStoreCustomers", this.scopedPayload(cursor, basePayload)); },

  async loadScopedPage(targetPage, epoch, basePayload) {
    const stack = this.data.cursorStack.length ? this.data.cursorStack.slice() : [null];
    while (targetPage > 1 && !stack[targetPage - 1]) {
      const pageToDiscover = stack.length;
      const intermediate = await this.fetchScoped(stack[pageToDiscover - 1] || null, basePayload);
      if (epoch !== this._requestEpoch) return false;
      if (!intermediate.hasMore || !intermediate.nextCursor) break;
      stack[pageToDiscover] = intermediate.nextCursor;
    }
    if (targetPage > 1 && !stack[targetPage - 1]) throw new Error("目标页已超出当前查询结果");
    const result = await this.fetchScoped(stack[targetPage - 1] || null, basePayload);
    if (epoch !== this._requestEpoch) return false;
    if (result.hasMore && result.nextCursor) stack[targetPage] = result.nextCursor;
    else stack.splice(targetPage);
    const summary = result.summary || {};
    const total = Number(summary.selectedTotal || 0);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (targetPage > totalPages && total > 0) throw new Error(`请输入 1 到 ${totalPages} 的有效页码`);
    this.setData({
      customers: customerRows(result.customers || []), summary, total, totalPages,
      page: targetPage, pageJump: String(targetPage), hasMore: result.hasMore === true,
      cursorStack: stack, nextCursor: result.nextCursor || null, tableScrollLeft: 0
    });
    return true;
  },

  async load(page = 1) {
    const targetPage = Math.max(1, Number(page) || 1);
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const basePayload = this.scopedPayload();
    this.setData({ loading: true, message: "", error: false });
    try {
      await this.loadScopedPage(targetPage, epoch, basePayload);
    } catch (error) {
      if (epoch !== this._requestEpoch) return;
      this.setData({
        customers: [], page: 1, pageJump: "1", total: 0, totalPages: 1, hasMore: false,
        cursorStack: [null], nextCursor: null, summary: { ...EMPTY_SUMMARY }, tableScrollLeft: 0,
        message: error.message || "客户读取失败", error: true
      });
    } finally {
      if (epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },

  invalidateRequest(changes) {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this.setData({ ...(changes || {}), loading: false });
  },

  setMode(event) { this.invalidateRequest({ mode: event.currentTarget.dataset.mode === "manual" ? "manual" : "browse" }); this.resetPaging(); },
  chooseStore(event) { this.invalidateRequest({ storeIndex: Number(event.detail.value) }); },
  chooseProcess(event) { this.invalidateRequest({ processIndex: Number(event.detail.value) }); },
  chooseStatus(event) { this.invalidateRequest({ statusIndex: Number(event.detail.value) }); },
  chooseTime(event) {
    const timeIndex = Number(event.detail.value);
    const timeValue = this.data.timeValues[timeIndex] || "ALL";
    const range = query.timeRange(timeValue, { startDate: this.data.startDate, endDate: this.data.endDate });
    this.invalidateRequest({ timeIndex, customRange: timeValue === "CUSTOM", startDate: range.startDate, endDate: range.endDate });
  },
  changeStart(event) { this.invalidateRequest({ startDate: event.detail.value }); },
  changeEnd(event) { this.invalidateRequest({ endDate: event.detail.value }); },
  inputName(event) { this.invalidateRequest({ name: event.detail.value }); },
  inputBirthday(event) { this.invalidateRequest({ birthDate: event.detail.value }); },
  search() {
    if (this.data.startDate && this.data.endDate && this.data.startDate > this.data.endDate) {
      this.setData({ message: "开始日期不能晚于结束日期", error: true }); return;
    }
    this.invalidateRequest(); this.resetPaging(); this.load(1);
  },
  resetSearch() {
    this.invalidateRequest({
      mode: "browse", storeIndex: 0, processIndex: 0, statusIndex: 0, timeIndex: 0,
      customRange: false, startDate: "", endDate: "", name: "", birthDate: ""
    });
    this.resetPaging(); this.load(1);
  },
  previousPage() { if (!this.data.loading && this.data.page > 1) this.load(this.data.page - 1); },
  nextPage() { if (!this.data.loading && this.data.page < this.data.totalPages) this.load(this.data.page + 1); },
  inputPageJump(event) { this.setData({ pageJump: String(event.detail.value || "") }); },
  jumpPage() {
    const page = Number(this.data.pageJump);
    if (!Number.isInteger(page) || page < 1 || page > this.data.totalPages) {
      this.setData({ message: `请输入 1 到 ${this.data.totalPages} 的有效页码`, error: true }); return;
    }
    this.load(page);
  },
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  }
});

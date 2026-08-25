const { callFace, callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");

const PAGE_SIZE = 20;
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
    birthDate: query.displayDate(item.birthDate), storeName: String(item.storeName || "—"),
    statusLabel: String(item.customerStatus || "").toUpperCase() === "ARCHIVED" ? "已封存" : "活跃",
    processLabel: processLabel(item.customerProcessStatus),
    rechargeCount: Number(item.totalRechargeCount !== undefined ? item.totalRechargeCount : item.rechargeCount || 0),
    verificationCount: Number(item.totalVerificationCount !== undefined ? item.totalVerificationCount : item.verificationCount || 0),
    createdAtLabel: query.displayDate(item.createdAt)
  }));
}

Page({
  data: {
    session: {}, loading: false, message: "", error: false, mode: "browse", updatingCode: "",
    customers: [], page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1, hasMore: false, pageJump: "1",
    cursorStack: [null], nextCursor: null,
    stores: [], storeLabels: ["全部门店"], storeIndex: 0,
    processLabels: labels(query.CUSTOMER_PROCESS_OPTIONS), processValues: values(query.CUSTOMER_PROCESS_OPTIONS), processIndex: 0,
    statusLabels: labels(query.CUSTOMER_STATUS_OPTIONS), statusValues: values(query.CUSTOMER_STATUS_OPTIONS), statusIndex: 0,
    timeLabels: labels(query.TIME_OPTIONS), timeValues: values(query.TIME_OPTIONS), timeIndex: 0,
    customRange: false, startDate: "", endDate: "", today: query.businessToday(),
    name: "", birthDate: "", teacherStatus: "ACTIVE",
    summary: { total: 0, selectedTotal: 0, active: 0, archived: 0, informationOnly: 0, rechargedNoConsumption: 0, rechargedWithConsumption: 0 }
  },

  async onLoad() {
    const session = requireSession();
    if (!session) return;
    this.setData({ session });
    if (session.role === "hq") await this.loadStores();
    await this.load(1);
  },
  onPullDownRefresh() { this.resetPaging(); this.load(1).finally(() => wx.stopPullDownRefresh()); },

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
  scopedPayload(cursor = null) {
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
  fetchScoped(cursor) { return callFace("queryStoreCustomers", this.scopedPayload(cursor)); },

  async loadScopedPage(targetPage) {
    const stack = this.data.cursorStack.length ? this.data.cursorStack.slice() : [null];
    while (targetPage > 1 && !stack[targetPage - 1]) {
      const pageToDiscover = stack.length;
      const intermediate = await this.fetchScoped(stack[pageToDiscover - 1] || null);
      if (!intermediate.hasMore || !intermediate.nextCursor) break;
      stack[pageToDiscover] = intermediate.nextCursor;
    }
    if (targetPage > 1 && !stack[targetPage - 1]) throw new Error("目标页已超出当前查询结果");
    const result = await this.fetchScoped(stack[targetPage - 1] || null);
    if (result.hasMore && result.nextCursor) stack[targetPage] = result.nextCursor;
    else stack.splice(targetPage);
    const summary = result.summary || {};
    const total = Number(summary.selectedTotal || 0);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (targetPage > totalPages && total > 0) throw new Error(`请输入 1 到 ${totalPages} 的有效页码`);
    this.setData({
      customers: customerRows(result.customers || []), summary, total, totalPages,
      page: targetPage, pageJump: String(targetPage), hasMore: result.hasMore === true,
      cursorStack: stack, nextCursor: result.nextCursor || null
    });
  },

  async loadTeacherPage(targetPage) {
    const status = this.data.teacherStatus;
    const payload = status === "ACTIVE" ? { activePage: targetPage, archivedPage: 1 } : { activePage: 1, archivedPage: targetPage };
    const result = await callFace("getTeacherBusinessCustomers", payload);
    const group = status === "ACTIVE" ? result.active : result.archived;
    const total = Number(group.total || 0);
    const pageSize = Number(group.pageSize || 10);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    this.setData({
      customers: customerRows(group.records || []), total, pageSize, totalPages,
      page: targetPage, pageJump: String(targetPage), hasMore: targetPage < totalPages
    });
  },

  async load(page = 1) {
    if (this.data.loading) return;
    const targetPage = Math.max(1, Number(page) || 1);
    this.setData({ loading: true, message: "", error: false });
    try {
      if (this.data.session.role === "teacher") await this.loadTeacherPage(targetPage);
      else await this.loadScopedPage(targetPage);
    } catch (error) { this.setData({ customers: [], message: error.message || "客户读取失败", error: true }); }
    finally { this.setData({ loading: false }); }
  },

  setMode(event) { this.setData({ mode: event.currentTarget.dataset.mode === "manual" ? "manual" : "browse" }); this.resetPaging(); },
  chooseStore(event) { this.setData({ storeIndex: Number(event.detail.value) }); },
  chooseProcess(event) { this.setData({ processIndex: Number(event.detail.value) }); },
  chooseStatus(event) { this.setData({ statusIndex: Number(event.detail.value) }); },
  chooseTime(event) {
    const timeIndex = Number(event.detail.value);
    const timeValue = this.data.timeValues[timeIndex] || "ALL";
    const range = query.timeRange(timeValue, { startDate: this.data.startDate, endDate: this.data.endDate });
    this.setData({ timeIndex, customRange: timeValue === "CUSTOM", startDate: range.startDate, endDate: range.endDate });
  },
  changeStart(event) { this.setData({ startDate: event.detail.value }); },
  changeEnd(event) { this.setData({ endDate: event.detail.value }); },
  inputName(event) { this.setData({ name: event.detail.value }); },
  inputBirthday(event) { this.setData({ birthDate: event.detail.value }); },
  changeTeacherStatus(event) { this.setData({ teacherStatus: event.currentTarget.dataset.status }); this.load(1); },
  search() {
    if (this.data.startDate && this.data.endDate && this.data.startDate > this.data.endDate) {
      this.setData({ message: "开始日期不能晚于结束日期", error: true }); return;
    }
    this.resetPaging(); this.load(1);
  },
  resetSearch() {
    this.setData({
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
  toggleCustomerStatus(event) {
    if (this.data.session.role === "teacher" || this.data.loading || this.data.updatingCode) return;
    const customerCode = String(event.currentTarget.dataset.code || "");
    const currentStatus = String(event.currentTarget.dataset.status || "").toUpperCase();
    if (!customerCode || !["ACTIVE", "ARCHIVED"].includes(currentStatus)) return;
    const restoring = currentStatus === "ARCHIVED";
    wx.showModal({
      title: restoring ? "恢复为活跃" : "封存客户",
      content: restoring ? `确认将客户 ${customerCode} 恢复为活跃？` : `确认将客户 ${customerCode} 设为存档？历史记录会继续保留。`,
      confirmText: restoring ? "确认恢复" : "确认封存",
      confirmColor: restoring ? "#16845b" : "#9a302b",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ updatingCode: customerCode, message: "", error: false });
        try {
          await callFace("updateCustomerStatus", {
            customerCode, expectedStatus: currentStatus,
            targetStatus: restoring ? "ACTIVE" : "ARCHIVED"
          });
          this.resetPaging();
          await this.load(1);
          this.setData({ message: restoring ? "客户已恢复为活跃" : "客户已封存", error: false });
        } catch (error) {
          this.setData({ message: error.message || "客户状态更新失败", error: true });
        } finally { this.setData({ updatingCode: "" }); }
      }
    });
  },
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  }
});

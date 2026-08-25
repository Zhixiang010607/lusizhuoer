const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

const PAGE_SIZE = 100;
const STATUS = Object.freeze([
  { value: "", label: "全部状态" },
  { value: "PENDING", label: "待审核" },
  { value: "APPROVED", label: "审核通过" },
  { value: "REJECTED", label: "已驳回" }
]);

function text(...values) {
  const value = values.find((item) => item !== undefined && item !== null && String(item).trim());
  return String(value || "").trim();
}
function pick(row, snake, camel) { return row?.[snake] ?? row?.[camel] ?? ""; }
function dateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "—";
  return new Date(parsed.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function normalize(row, recharge) {
  const applicationType = text(pick(row, "application_type", "applicationType")).toUpperCase();
  const status = text(pick(row, "application_status", "applicationStatus")).toUpperCase() || "PENDING";
  const isRefund = applicationType === "REFUND";
  const isVoid = applicationType === "VOID";
  const amount = Number(pick(row, "unit_count", "unitCount")) || 0;
  const customerCode = text(pick(row, "customer_code", "customerCode"));
  return {
    id: text(row.id), recordCode: text(pick(row, "record_code", "recordCode")), status,
    statusLabel: { PENDING: "待审核", APPROVED: "审核通过", REJECTED: "已驳回" }[status] || status,
    kind: recharge ? (isRefund ? "退费申请" : isVoid ? "历史作废" : "充值申请") : "补录核销",
    storeId: text(pick(row, "store_id", "storeId")), storeName: text(pick(row, "store_name", "storeName")) || "未命名门店",
    storeCode: text(pick(row, "store_code", "storeCode")), customerCode,
    customerName: text(pick(row, "customer_name", "customerName")) || "未命名客户",
    productName: text(pick(row, "product_name", "productName")) || "未命名项目",
    teacherName: text(pick(row, "teacher_name", "teacherName")) || "—",
    impact: recharge ? `${isRefund || isVoid ? "−" : "+"}${amount} 次` : `核销 +${amount || 1} 次`,
    submittedAt: dateTime(pick(row, "application_time", "applicationTime")),
    reviewedAt: status === "PENDING" ? "—" : dateTime(isVoid ? pick(row, "void_reviewed_at", "voidReviewedAt") : pick(row, "original_reviewed_at", "originalReviewedAt")),
    applicantNote: text(isVoid ? pick(row, "void_request_note", "voidRequestNote") : pick(row, "initial_store_note", "initialStoreNote")) || "无"
  };
}

Page({
  data: {
    session: {}, type: "recharge", recordType: "RECHARGE", noun: "充值", loading: true, deciding: false,
    message: "", error: false, mode: "filters", code: "", rows: [], total: 0, page: 1, totalPages: 1, pageJump: "1",
    stores: [], storeLabels: ["全部门店"], storeIndex: 0,
    statusLabels: STATUS.map((item) => item.label), statusIndex: 0,
    pendingOpen: false, pending: null, decision: "APPROVED", reviewNote: ""
  },
  async onLoad(options) {
    const session = requireSession(["hq"]);
    if (!session) return;
    const requested = String(options.type || "recharge").toLowerCase();
    const type = ["recharge", "refund", "verification"].includes(requested) ? requested : "recharge";
    const noun = type === "verification" ? "核销" : type === "refund" ? "退费" : "充值";
    this.setData({ session, type, noun, recordType: type === "verification" ? "VERIFICATION" : "RECHARGE" });
    wx.setNavigationBarTitle({ title: `${noun}审核` });
    await this.load(1, true);
  },
  onPullDownRefresh() { this.load(1, true).finally(() => wx.stopPullDownRefresh()); },
  onUnload() { this._requestEpoch = Number(this._requestEpoch || 0) + 1; },
  openReviewType(event) {
    const type = String(event.currentTarget.dataset.type || "recharge");
    if (!["recharge", "refund"].includes(type) || type === this.data.type) return;
    wx.redirectTo({ url: `/pages/reviews/index?type=${type}` });
  },
  setMode(event) {
    const mode = event.currentTarget.dataset.mode === "code" ? "code" : "filters";
    this.invalidateRequest({ mode, code: "", rows: [], total: 0, page: 1, totalPages: 1, pageJump: "1", message: "", error: false });
  },
  chooseStore(event) { this.invalidateRequest({ storeIndex: Number(event.detail.value) }); },
  chooseStatus(event) { this.invalidateRequest({ statusIndex: Number(event.detail.value) }); },
  inputCode(event) { this.invalidateRequest({ code: String(event.detail.value || "").toUpperCase() }); },
  inputPage(event) { this.setData({ pageJump: String(event.detail.value || "") }); },
  runQuery() { this.load(1, this.data.storeLabels.length <= 1); },
  resetQuery() { this.invalidateRequest({ storeIndex: 0, statusIndex: 0, code: "", pageJump: "1" }); this.load(1, true); },
  invalidateRequest(changes) {
    this._requestEpoch = Number(this._requestEpoch || 0) + 1;
    this.setData({ ...(changes || {}), loading: false });
  },
  async load(page = 1, reloadStores = false) {
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const mode = this.data.mode;
    const recordType = this.data.recordType;
    const noun = this.data.noun;
    const type = this.data.type;
    const recordCode = this.data.mode === "code" ? text(this.data.code).toUpperCase() : "";
    if (mode === "code" && !recordCode) {
      this.setData({ rows: [], total: 0, message: `请输入完整${this.data.noun}工单编号`, error: true, loading: false }); return;
    }
    const payload = {
      recordType, recordCode,
      storeId: mode === "filters" && this.data.storeIndex > 0 ? this.data.stores[this.data.storeIndex - 1]?.id || "" : "",
      applicationType: type === "recharge" ? "NEW" : type === "refund" ? "REFUND" : "SUPPLEMENT",
      status: mode === "filters" ? STATUS[this.data.statusIndex]?.value || "" : "",
      limit: mode === "code" ? 1 : PAGE_SIZE,
      paged: mode === "filters", pageNumber: mode === "filters" ? page : undefined
    };
    this.setData({ loading: true, message: "", error: false });
    try {
      const result = await callStaff("listReviewOrders", payload);
      if (epoch !== this._requestEpoch) return;
      const rows = (result.orders || []).map((row) => normalize(row, recordType === "RECHARGE"));
      const total = mode === "filters" ? Number(result.total || 0) : rows.length;
      const totalPages = mode === "filters" ? Math.max(1, Number(result.totalPages || 1)) : 1;
      const currentPage = mode === "filters" ? Math.min(totalPages, Math.max(1, Number(result.pageNumber || page))) : 1;
      const changes = { rows, total, totalPages, page: currentPage, pageJump: String(currentPage) };
      if (reloadStores || this.data.storeLabels.length <= 1) {
        const source = result.stores || [];
        changes.stores = source.map((store) => ({
          id: text(store.store_id, store.id), label: [text(store.store_name, store.name) || "未命名门店", text(store.store_code, store.code)].filter(Boolean).join(" · ")
        })).filter((store) => store.id);
        changes.storeLabels = ["全部门店", ...changes.stores.map((store) => store.label)];
        changes.storeIndex = 0;
      }
      this.setData(changes);
    } catch (error) {
      if (epoch !== this._requestEpoch) return;
      this.setData({ rows: [], total: 0, page: 1, totalPages: 1, pageJump: "1", message: error.message || `${noun}审核工单读取失败`, error: true });
    } finally {
      if (epoch === this._requestEpoch) this.setData({ loading: false });
    }
  },
  previousPage() { if (!this.data.loading && this.data.page > 1) this.load(this.data.page - 1); },
  nextPage() { if (!this.data.loading && this.data.page < this.data.totalPages) this.load(this.data.page + 1); },
  jumpPage() {
    const page = Number(this.data.pageJump);
    if (!Number.isInteger(page) || page < 1 || page > this.data.totalPages) {
      this.setData({ message: `请输入 1 到 ${this.data.totalPages} 的有效页码`, error: true }); return;
    }
    this.load(page);
  },
  openOrder(event) {
    const id = text(event.currentTarget.dataset.id);
    const code = text(event.currentTarget.dataset.code);
    if (id) wx.navigateTo({ url: `/pages/order-detail/index?type=${this.data.recordType.toLowerCase()}&recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}` });
  },
  openCustomer(event) {
    const code = text(event.currentTarget.dataset.code);
    if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
  },
  openDecision(event) {
    const item = this.data.rows.find((row) => row.id === String(event.currentTarget.dataset.id || ""));
    const decision = String(event.currentTarget.dataset.decision || "");
    if (!item || item.status !== "PENDING" || !["APPROVED", "REJECTED"].includes(decision)) return;
    this.setData({ pendingOpen: true, pending: item, decision, reviewNote: "" });
  },
  closeDecision() { if (!this.data.deciding) this.setData({ pendingOpen: false, pending: null, reviewNote: "" }); },
  inputReviewNote(event) { this.setData({ reviewNote: event.detail.value }); },
  noop() {},
  async confirmDecision() {
    if (this.data.deciding || !this.data.pending) return;
    this.setData({ deciding: true, message: "正在提交审核结果…", error: false });
    try {
      await callStaff("reviewOrder", {
        recordType: this.data.recordType, recordId: this.data.pending.id,
        decision: this.data.decision, note: text(this.data.reviewNote)
      });
      const code = this.data.pending.recordCode;
      this.setData({ pendingOpen: false, pending: null, reviewNote: "", message: `${code} 审核结果已保存`, error: false });
      await this.load(this.data.page);
    } catch (error) {
      this.setData({ message: error.message || "工单审核失败", error: true });
    } finally { this.setData({ deciding: false }); }
  }
});

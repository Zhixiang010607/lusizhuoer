const { callFace } = require("../../services/api");
const { requireSession } = require("../../services/session");

function today() { return new Date().toISOString().slice(0, 10); }

Page({
  data: { session: {}, status: "ACTIVE", customers: [], page: 1, hasMore: false, total: 0, loading: false, name: "", birthDate: "", today: today(), message: "", cursorStack: [], nextCursor: null },
  onLoad() {
    const session = requireSession();
    if (!session) return;
    this.setData({ session });
    this.load();
  },
  onPullDownRefresh() { this.setData({ page: 1, cursorStack: [], nextCursor: null }); this.load().finally(() => wx.stopPullDownRefresh()); },
  inputName(event) { this.setData({ name: event.detail.value }); },
  inputBirthday(event) { this.setData({ birthDate: event.detail.value }); },
  changeStatus(event) { this.setData({ status: event.currentTarget.dataset.status, page: 1, cursorStack: [], nextCursor: null }); this.load(); },
  search() { this.setData({ page: 1, cursorStack: [], nextCursor: null }); this.load(); },
  resetSearch() { this.setData({ name: "", birthDate: "", page: 1, cursorStack: [], nextCursor: null }); this.load(); },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, message: "" });
    try {
      if (this.data.session.role === "teacher") {
        const payload = this.data.status === "ACTIVE" ? { activePage: this.data.page, archivedPage: 1 } : { activePage: 1, archivedPage: this.data.page };
        const result = await callFace("getTeacherBusinessCustomers", payload);
        const group = this.data.status === "ACTIVE" ? result.active : result.archived;
        this.setData({ customers: group.records || [], total: Number(group.total || 0), hasMore: this.data.page * Number(group.pageSize || 10) < Number(group.total || 0) });
      } else {
        const cursor = this.data.cursorStack[this.data.page - 1] || null;
        const manual = Boolean(String(this.data.name || "").trim() || this.data.birthDate);
        const payload = {
          mode: manual ? "manual" : "browse",
          customerStatus: manual ? "ALL" : this.data.status,
          name: String(this.data.name || "").trim(), birthDate: this.data.birthDate,
          limit: 10
        };
        if (this.data.session.role === "store") payload.storeId = this.data.session.storeId;
        if (cursor) { payload.cursorCreatedAt = cursor.createdAt; payload.cursorId = cursor.id; }
        const result = await callFace("queryStoreCustomers", payload);
        this.setData({ customers: result.customers || [], hasMore: result.hasMore === true, nextCursor: result.nextCursor || null });
      }
    } catch (error) {
      this.setData({ customers: [], hasMore: false, message: error.message || "客户读取失败" });
    } finally { this.setData({ loading: false }); }
  },
  nextPage() {
    if (!this.data.hasMore) return;
    if (this.data.session.role !== "teacher") {
      const stack = this.data.cursorStack.slice();
      stack[this.data.page] = this.data.nextCursor;
      this.setData({ cursorStack: stack });
    }
    this.setData({ page: this.data.page + 1 }); this.load();
  },
  previousPage() { if (this.data.page > 1) { this.setData({ page: this.data.page - 1 }); this.load(); } },
  openCustomer(event) { wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(event.currentTarget.dataset.code)}` }); }
});

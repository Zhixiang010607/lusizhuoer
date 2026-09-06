const { callFace } = require("../../services/api");
const { waitForStartupSession, requireSession } = require("../../services/session");
const dashboard = require("../../services/home-dashboard");

function emptyGroup() { return { rows: [], total: 0, page: 1, totalPages: 1 }; }

Page({
  data: {
    authorized: false, status: "ACTIVE", loading: true, message: "", error: false,
    group: emptyGroup(), pages: { ACTIVE: 1, ARCHIVED: 1 }, pageInput: "1",
    counts: { ACTIVE: null, ARCHIVED: null }, tableHeight: 0
  },
  async onShow() {
    this._unloaded = false;
    const epoch = this._startupEpoch = (this._startupEpoch || 0) + 1;
    this.setData({ authorized: false, loading: true, group: emptyGroup(), message: "", error: false });
    await waitForStartupSession();
    if (this._unloaded || epoch !== this._startupEpoch) return;
    const session = requireSession(["teacher"]);
    if (!session) return;
    if (this._uid !== session.uid) this.setData({ status: "ACTIVE", pages: { ACTIVE: 1, ARCHIVED: 1 }, counts: { ACTIVE: null, ARCHIVED: null } });
    this._uid = session.uid;
    this.setData({ authorized: true });
    return this.loadPage(this.data.pages[this.data.status]);
  },
  onUnload() {
    this._unloaded = true;
    this._startupEpoch = (this._startupEpoch || 0) + 1;
    this._requestEpoch = (this._requestEpoch || 0) + 1;
    this._measureEpoch = (this._measureEpoch || 0) + 1;
  },
  onResize() { this.measureTable(); },
  async loadPage(page = 1) {
    if (!this.data.authorized || this._unloaded) return;
    const status = this.data.status;
    const epoch = this._requestEpoch = (this._requestEpoch || 0) + 1;
    const payload = {
      activePage: status === "ACTIVE" ? page : this.data.pages.ACTIVE,
      archivedPage: status === "ARCHIVED" ? page : this.data.pages.ARCHIVED
    };
    this._retryPage = page;
    this._measureEpoch = (this._measureEpoch || 0) + 1;
    this.setData({ loading: true, group: emptyGroup(), tableHeight: 0, message: "", error: false });
    try {
      const result = await callFace("getTeacherBusinessCustomers", payload);
      if (this._unloaded || epoch !== this._requestEpoch || status !== this.data.status) return;
      if (!Array.isArray(result.active?.records) || !Array.isArray(result.archived?.records)) throw new Error("客户列表未返回完整结果，请重新读取。");
      const group = dashboard.customerGroup(status === "ACTIVE" ? result.active : result.archived);
      this.setData({
        group, pages: { ...this.data.pages, [status]: group.page }, pageInput: String(group.page),
        counts: { ACTIVE: dashboard.count(result.active.total), ARCHIVED: dashboard.count(result.archived.total) }
      }, () => this.measureTable());
    } catch (error) {
      if (this._unloaded || epoch !== this._requestEpoch || status !== this.data.status) return;
      this.setData({ group: emptyGroup(), counts: { ...this.data.counts, [status]: null }, message: error.message || "客户列表读取失败，请重试。", error: true });
    } finally {
      if (!this._unloaded && epoch === this._requestEpoch && status === this.data.status) this.setData({ loading: false }, () => this.measureTable());
    }
  },
  chooseStatus(event) {
    const status = event.currentTarget.dataset.status;
    if (!["ACTIVE", "ARCHIVED"].includes(status) || status === this.data.status) return;
    this.setData({ status });
    return this.loadPage(this.data.pages[status]);
  },
  previousPage() { if (!this.data.loading && this.data.group.page > 1) return this.loadPage(this.data.group.page - 1); },
  nextPage() { if (!this.data.loading && this.data.group.page < this.data.group.totalPages) return this.loadPage(this.data.group.page + 1); },
  inputPage(event) { this.setData({ pageInput: event.detail.value }); },
  jumpPage() {
    if (this.data.loading) return;
    const raw = String(this.data.pageInput || "").trim();
    const page = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1 || page > this.data.group.totalPages) {
      this.setData({ message: `请输入 1 至 ${this.data.group.totalPages} 之间的页码`, error: false });
      return;
    }
    return this.loadPage(page);
  },
  retry() { if (!this.data.loading) return this.loadPage(this._retryPage || 1); },
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (this.data.loading || !this.data.group.rows.some((row) => row.customerCode === code)) return;
    wx.navigateTo({ url: `/pages/customer-detail/index?code=${encodeURIComponent(code)}` });
  },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/home/index" });
  },
  measureTable() {
    const epoch = this._measureEpoch = (this._measureEpoch || 0) + 1;
    if (this._unloaded || this.data.loading || !this.data.group.rows.length) return;
    wx.nextTick(() => {
      if (this._unloaded || epoch !== this._measureEpoch) return;
      this.createSelectorQuery().select(".customer-table").boundingClientRect((rect) => {
        if (this._unloaded || epoch !== this._measureEpoch || !(rect?.height > 0)) return;
        const tableHeight = Math.ceil(rect.height);
        if (tableHeight !== this.data.tableHeight) this.setData({ tableHeight });
      }).exec();
    });
  }
});

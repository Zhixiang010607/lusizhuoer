const { callFace } = require("../../services/api");
const { requireSession, waitForStartupSession } = require("../../services/session");
const { formatCustomerAge } = require("../../services/customer-age");
const { displayDateAny, CUSTOMER_PROCESS_OPTIONS } = require("../../services/query-tools");

Page({
  data: { stores: [], store: {}, name: "", loadingStores: true, loading: false,
    searched: false, customers: [], total: 0, page: 1, totalPages: 1, pageInput: "1",
    tableHeight: 0, message: "", error: false },
  onLoad() {
    if (!requireSession(["teacher"])) return;
    wx.setNavigationBarTitle({ title: "露思卓儿" });
  },
  async onShow() {
    await waitForStartupSession();
    const session = requireSession(["teacher"]);
    if (!session) return;
    if (this._uid === session.uid) return;
    this._uid = session.uid;
    const epoch = this._epoch = Number(this._epoch || 0) + 1;
    this.setData({ stores: [], store: {}, name: "", customers: [], searched: false, loading: false,
      loadingStores: true, message: "", error: false });
    try {
      const result = await callFace("getTeacherBusinessContext");
      if (epoch !== this._epoch) return;
      this.setData({ stores: (result.stores || []).map(row => ({ id: String(row.storeId || row.id), name: row.storeName || row.name || "" })) });
    } catch (error) {
      if (epoch === this._epoch) { this._uid = ""; this.setData({ message: error.message || "门店读取失败，请重试", error: true }); }
    } finally { if (epoch === this._epoch) this.setData({ loadingStores: false }); }
  },
  onUnload() { this._epoch = Number(this._epoch || 0) + 1; this._selection = null; },
  clearResults(changes = {}) {
    this._epoch = Number(this._epoch || 0) + 1;
    this._selection = null;
    this.setData({ customers: [], total: 0, searched: false, loading: false, tableHeight: 0,
      page: 1, totalPages: 1, pageInput: "1", message: "", error: false, ...changes });
  },
  selectStore(event) { this.clearResults({ store: this.data.stores[Number(event.detail.value) - 1] || {} }); },
  inputName(event) { this.clearResults({ name: String(event.detail.value || "") }); },
  search() { return this.loadPage(1); },
  async loadPage(page) {
    const session = requireSession(["teacher"]);
    if (!session || session.uid !== this._uid || this.data.loading) return;
    const customerName = this.data.name.trim();
    if (!this.data.store.id || !customerName) {
      this.setData({ message: "请选择门店并输入完整客户姓名", error: true }); return;
    }
    const selection = { storeId: this.data.store.id, customerName };
    const epoch = this._epoch = Number(this._epoch || 0) + 1;
    const preserveRows = this._selection && this._selection.storeId === selection.storeId && this._selection.customerName === customerName;
    this._selection = null;
    this.setData({ loading: true, customers: preserveRows ? this.data.customers : [], tableHeight: preserveRows ? this.data.tableHeight : 0, message: "", error: false });
    try {
      const result = await callFace("queryTeacherCustomers", { teacherLookup: selection, page });
      if (epoch !== this._epoch) return;
      const customers = (result.customers || []).map(row => ({ ...row,
        ageLabel: formatCustomerAge(displayDateAny(row.birthDate)),
        stageLabel: (CUSTOMER_PROCESS_OPTIONS.find(item => item.value === row.customerProcessStatus)?.label || "—"), createdLabel: displayDateAny(row.createdAt),
        statusLabel: row.customerStatus === "ARCHIVED" ? "封存" : "活跃" }));
      this._selection = selection;
      this.setData({ searched: true, customers, total: Number(result.total || 0),
        page: Number(result.page || 1), totalPages: Number(result.totalPages || 1), pageInput: String(result.page || 1) }, () => this.measureTable());
    } catch (error) {
      if (epoch === this._epoch) this.setData({ searched: false, message: error.message || "查询失败，请重试", error: true });
    } finally { if (epoch === this._epoch) this.setData({ loading: false }); }
  },
  previousPage() { if (this.data.page > 1) return this.loadPage(this.data.page - 1); },
  nextPage() { if (this.data.page < this.data.totalPages) return this.loadPage(this.data.page + 1); },
  inputPage(event) { this.setData({ pageInput: String(event.detail.value || "") }); },
  jumpPage() {
    const raw = this.data.pageInput.trim(), page = Number(raw);
    if (!/^\d+$/.test(raw) || page < 1 || page > this.data.totalPages) {
      this.setData({ message: `请输入 1 至 ${this.data.totalPages} 的页码`, error: true }); return;
    }
    return this.loadPage(page);
  },
  openCustomer(event) {
    const code = String(event.currentTarget.dataset.code || "");
    if (!this._selection || !this.data.customers.some(row => row.customerCode === code)) return;
    const lookup = { ...this._selection, customerCode: code };
    wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}&teacherLookup=${encodeURIComponent(JSON.stringify(lookup))}` });
  },
  retryStores() { this._uid = ""; return this.onShow(); },
  measureTable() {
    wx.nextTick(() => { this.createSelectorQuery().select(".customer-table").boundingClientRect(rect => {
      if (rect?.height) this.setData({ tableHeight: Math.ceil(rect.height) });
    }).exec(); });
  },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({ url: "/pages/home/index" }); }
});

const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore, setSelectedStore, signOut } = require("../../services/session");

const ROLE_META = { hq: ["总部", "总"], store: ["门店", "店"], teacher: ["老师", "师"] };

Page({
  data: {
    session: {}, roleName: "", roleIcon: "", stores: [], storeLabels: [], storeIndex: 0,
    selectedStore: null, loadingStores: false, storeMessage: "", storeError: false,
    experienceBalances: [], message: "", error: false
  },
  onShow() {
    const session = requireSession();
    if (!session) return;
    const meta = ROLE_META[session.role] || ["账号", "账"];
    this.setData({ session, roleName: meta[0], roleIcon: meta[1], selectedStore: getSelectedStore(session), message: "", error: false });
    if (session.role === "teacher") this.loadTeacherContext();
  },
  async loadTeacherContext() {
    this.setData({ loadingStores: true, storeMessage: "", storeError: false });
    try {
      const context = await callFace("getTeacherBusinessContext");
      const stores = (context.stores || []).map((store) => ({ id: String(store.storeId), code: String(store.storeCode || ""), name: String(store.storeName || "") }));
      const saved = getSelectedStore(this.data.session);
      const selected = stores.find((item) => saved && item.id === saved.id) || null;
      this.setData({ stores, storeLabels: stores.map((item) => `${item.name} · ${item.code || item.id}`), selectedStore: selected, storeIndex: Math.max(0, stores.findIndex((item) => selected && item.id === selected.id)) });
      const overview = await callFace("getTeacherWorkspace", { recordType: "VERIFICATION", page: 1, pageSize: 1, includeOverview: true });
      this.setData({ experienceBalances: overview.experienceBalances || [] });
    } catch (error) {
      this.setData({ storeMessage: error.message || "老师工作台读取失败", storeError: true });
    } finally { this.setData({ loadingStores: false }); }
  },
  selectStore(event) {
    const selected = this.data.stores[Number(event.detail.value)];
    if (!selected) return;
    setSelectedStore(selected, this.data.session);
    this.setData({ selectedStore: selected, storeIndex: Number(event.detail.value), storeMessage: `本次业务已绑定 ${selected.name}`, storeError: false });
  },
  ensureBusinessStore() {
    if (!["store", "teacher"].includes(this.data.session.role)) {
      this.setData({ message: "总部账号不能办理业务", error: true });
      return null;
    }
    const store = getSelectedStore(this.data.session);
    if (!store) {
      this.setData({ message: "老师办理业务前必须先选择门店", error: true });
      return null;
    }
    return store;
  },
  openCustomerCreate() { if (this.ensureBusinessStore()) wx.navigateTo({ url: "/pages/customer-create/index" }); },
  openRecharge(event) { if (this.ensureBusinessStore()) wx.navigateTo({ url: `/pages/recharge/index?mode=${event.currentTarget.dataset.mode}` }); },
  openVerification(event) { if (this.ensureBusinessStore()) wx.navigateTo({ url: `/pages/verification/index?mode=${event.currentTarget.dataset.mode}` }); },
  openCustomers() { wx.navigateTo({ url: "/pages/customers/index" }); },
  async logout() {
    await signOut();
    wx.reLaunch({ url: "/pages/login/index" });
  }
});

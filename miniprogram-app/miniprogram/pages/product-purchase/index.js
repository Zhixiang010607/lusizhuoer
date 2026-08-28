const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore, setSelectedStore } = require("../../services/session");
const submission = require("../../services/submission");

function store(value = {}) {
  return { id: String(value.storeId || value.id || ""), code: String(value.storeCode || value.code || ""), name: String(value.storeName || value.name || "") };
}
function product(value = {}) {
  return { id: String(value.productId || ""), code: String(value.productCode || ""), name: String(value.productName || "") };
}
function teacher(value = {}) {
  return { teacherId: String(value.teacherId || ""), teacherCode: String(value.teacherCode || ""), teacherName: String(value.teacherName || "") };
}

Page({
  data: {
    session: {}, store: {}, stores: [], storeLabels: ["请选择门店"], storeIndex: 0,
    customer: null, products: [], productLabels: ["请选择激活产品"], productIndex: 0,
    selectedProduct: null, unitCount: "", note: "", loadingStores: false, loadingProducts: false,
    teachers: [], teacherLabels: ["正在读取业务老师…"], teacherIndex: 0, selectedTeacher: null,
    teacherOptionsReady: false, loadingTeachers: false,
    busy: false, locked: false, recovering: false, ready: false, message: "", error: false
  },
  onLoad() {
    const session = requireSession(["store", "teacher"]);
    if (!session) return;
    this.setData({ session });
    if (session.role === "store") {
      const selected = getSelectedStore(session);
      if (!selected?.id) return wx.reLaunch({ url: "/pages/home/index" });
      this.setData({ store: store(selected) });
      this.loadTeachers(); this.loadProducts();
    } else this.loadTeacherStores();
    if (submission.read("PRODUCT_PURCHASE")) {
      this.setData({ locked: true, message: "检测到上一次产品购买提交尚未确认，已锁定重复提交。" });
      this.recoverPending();
    }
  },
  onUnload() { this._storeEpoch = Number(this._storeEpoch || 0) + 1; this._productEpoch = Number(this._productEpoch || 0) + 1; this._teacherEpoch = Number(this._teacherEpoch || 0) + 1; },
  async loadTeacherStores() {
    const epoch = Number(this._storeEpoch || 0) + 1; this._storeEpoch = epoch;
    this.setData({ loadingStores: true, stores: [], storeLabels: ["请选择门店"], storeIndex: 0, store: {} });
    try {
      const result = await callFace("getTeacherBusinessContext");
      if (epoch !== this._storeEpoch) return;
      const stores = (result.stores || []).map(store).filter((item) => item.id && item.name);
      this.setData({ stores, storeLabels: ["请选择门店", ...stores.map((item) => `${item.name} · ${item.code || item.id}`)] });
    } catch (error) {
      if (epoch === this._storeEpoch) this.setData({ message: error.message || "可办理门店读取失败", error: true });
    } finally { if (epoch === this._storeEpoch) this.setData({ loadingStores: false }); }
  },
  selectStore(event) {
    if (this.data.busy || this.data.locked) return;
    const pickerIndex = Number(event.detail.value); const selected = this.data.stores[pickerIndex - 1];
    if (!selected?.id) return;
    setSelectedStore(selected, this.data.session);
    this._productEpoch = Number(this._productEpoch || 0) + 1;
    this._teacherEpoch = Number(this._teacherEpoch || 0) + 1;
    this.setData({
      store: selected, storeIndex: pickerIndex, customer: null,
      products: [], productLabels: ["请选择激活产品"], productIndex: 0, selectedProduct: null,
      teachers: [], teacherLabels: ["正在读取业务老师…"], teacherIndex: 0, selectedTeacher: null,
      teacherOptionsReady: false, unitCount: "", note: "", message: `已选择 ${selected.name}，请确认客户`, error: false
    });
    this.loadTeachers(); this.loadProducts(); this.syncReady();
  },
  customerChanged() { this.setData({ customer: null, unitCount: "", note: "", message: "", error: false }); this.syncReady(); },
  customerConfirmed(event) { const customer = event.detail.customer; this.setData({ customer, message: `已确认 ${customer.customerName}`, error: false }); this.syncReady(); },
  async loadTeachers() {
    const storeId = String(this.data.store.id || ""); if (!storeId) return;
    const epoch = Number(this._teacherEpoch || 0) + 1; this._teacherEpoch = epoch;
    this.setData({ loadingTeachers: true, teacherOptionsReady: false });
    try {
      const result = await callFace("listActiveTeachers", { storeId });
      if (epoch !== this._teacherEpoch || String(this.data.store.id || "") !== storeId) return;
      const activeTeachers = (result.teachers || []).map(teacher).filter((item) => item.teacherId);
      if (this.data.session.role === "teacher") {
        const selectedIndex = activeTeachers.findIndex((item) => item.teacherId === String(this.data.session.teacherId || ""));
        const selectedTeacher = selectedIndex >= 0 ? activeTeachers[selectedIndex] : null;
        this.setData({
          teachers: activeTeachers,
          teacherLabels: activeTeachers.map((item) => `${item.teacherName} · ${item.teacherCode}`),
          teacherIndex: Math.max(0, selectedIndex), selectedTeacher, teacherOptionsReady: true
        });
        if (!selectedTeacher) this.setData({ message: "当前老师不在该门店的可办理老师名单中，已禁止提交", error: true });
      } else {
        const options = [{ teacherId: "", teacherCode: "", teacherName: "不指定业务老师" }, ...activeTeachers];
        this.setData({
          teachers: options,
          teacherLabels: options.map((item) => item.teacherId ? `${item.teacherName} · ${item.teacherCode}` : item.teacherName),
          teacherIndex: 0, selectedTeacher: options[0], teacherOptionsReady: true
        });
      }
    } catch (error) {
      if (epoch === this._teacherEpoch && String(this.data.store.id || "") === storeId) {
        if (this.data.session.role === "store") {
          const blankTeacher = { teacherId: "", teacherCode: "", teacherName: "不指定业务老师" };
          this.setData({
            teachers: [blankTeacher], teacherLabels: [blankTeacher.teacherName], teacherIndex: 0,
            selectedTeacher: blankTeacher, teacherOptionsReady: true,
            message: error.message || "老师列表读取失败；仍可不指定老师办理", error: true
          });
        } else {
          this.setData({
            teachers: [], teacherLabels: [], teacherIndex: 0, selectedTeacher: null,
            teacherOptionsReady: true, message: error.message || "当前老师信息读取失败，已禁止提交", error: true
          });
        }
      }
    } finally {
      if (epoch === this._teacherEpoch) { this.setData({ loadingTeachers: false }); this.syncReady(); }
    }
  },
  async loadProducts() {
    const storeId = String(this.data.store.id || ""); if (!storeId) return;
    const epoch = Number(this._productEpoch || 0) + 1; this._productEpoch = epoch;
    this.setData({ loadingProducts: true, products: [], productLabels: ["正在读取激活产品…"], productIndex: 0, selectedProduct: null });
    try {
      const result = await callFace("listActiveRetailProducts", { storeId });
      if (epoch !== this._productEpoch || String(this.data.store.id || "") !== storeId) return;
      const products = (result.products || []).map(product).filter((item) => item.id && item.name);
      this.setData({ products, productLabels: ["请选择激活产品", ...products.map((item) => `${item.name} · ${item.code}`)] });
    } catch (error) {
      if (epoch === this._productEpoch) this.setData({ products: [], productLabels: ["激活产品读取失败"], message: error.message || "激活产品读取失败", error: true });
    } finally { if (epoch === this._productEpoch) { this.setData({ loadingProducts: false }); this.syncReady(); } }
  },
  selectProduct(event) { const index = Number(event.detail.value); this.setData({ productIndex: index, selectedProduct: this.data.products[index - 1] || null }); this.syncReady(); },
  selectTeacher(event) { const index = Number(event.detail.value); this.setData({ teacherIndex: index, selectedTeacher: this.data.teachers[index] || null }); this.syncReady(); },
  inputCount(event) { this.setData({ unitCount: event.detail.value }); this.syncReady(); },
  inputNote(event) { this.setData({ note: event.detail.value }); },
  syncReady() {
    const count = Number(this.data.unitCount);
    const teacherReady = this.data.session.role === "store"
      ? this.data.teacherOptionsReady
      : Boolean(this.data.selectedTeacher?.teacherId);
    this.setData({ ready: Boolean(this.data.store.id && this.data.customer && this.data.selectedProduct && teacherReady && Number.isInteger(count) && count >= 1 && count <= 999 && !this.data.locked) });
  },
  async submit() {
    if (this.data.busy || !this.data.ready) return;
    const payload = { storeId: this.data.store.id, customerCode: this.data.customer.customerCode, retailProductId: this.data.selectedProduct.id, teacherId: String(this.data.selectedTeacher?.teacherId || ""), unitCount: Number(this.data.unitCount), message: String(this.data.note || "").trim() };
    let intent;
    try { intent = submission.begin("PRODUCT_PURCHASE", payload); }
    catch (error) { return this.setData({ locked: true, message: error.message, error: true }); }
    this.setData({ busy: true, message: "正在提交；请勿退出或重复点击…", error: false });
    try {
      const result = await callFace("createRetailProductPurchaseApplication", { ...payload, clientRequestId: intent.clientRequestId });
      if (String(result.recordStatus || "") !== "PENDING" || !result.purchaseId || !result.purchaseCode) throw new Error("服务端未返回完整待审核购买单");
      submission.confirm("PRODUCT_PURCHASE", result.purchaseId); submission.clear("PRODUCT_PURCHASE");
      this.setData({ locked: false, unitCount: "", note: "", ready: false, message: `产品购买单 ${result.purchaseCode} 已提交，等待总部审核。`, error: false });
    } catch (error) {
      submission.markUncertain("PRODUCT_PURCHASE");
      this.setData({ locked: true, message: error.message || "提交结果待确认，已锁定重复提交", error: true });
      await this.recoverPending();
    } finally { this.setData({ busy: false }); this.syncReady(); }
  },
  async recoverPending() {
    if (this.data.recovering) return;
    this.setData({ recovering: true, locked: true });
    try {
      const result = await submission.recover("PRODUCT_PURCHASE");
      if (result.found && result.complete && result.purchaseId && result.purchaseCode) {
        submission.confirm("PRODUCT_PURCHASE", result.purchaseId); submission.clear("PRODUCT_PURCHASE");
        this.setData({ locked: false, message: `已找到上次产品购买单 ${result.purchaseCode}，不会重复提交。`, error: false });
      } else if (!result.found) {
        submission.clear("PRODUCT_PURCHASE");
        this.setData({ locked: false, message: "数据库未找到上次购买单，可以重新提交。", error: false });
      }
    } catch (error) { this.setData({ locked: true, message: error.message || "暂时无法核对上次提交", error: true }); }
    finally { this.setData({ recovering: false }); this.syncReady(); }
  }
});

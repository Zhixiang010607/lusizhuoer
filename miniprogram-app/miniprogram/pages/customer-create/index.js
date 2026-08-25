const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore, setSelectedStore } = require("../../services/session");
const { businessToday } = require("../../services/query-tools");

function requestId() { return `mp_customer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`.slice(0, 64); }
function businessStore(value) {
  value = value || {};
  return {
    id: String(value.storeId || value.id || ""),
    code: String(value.storeCode || value.code || ""),
    name: String(value.storeName || value.name || "")
  };
}

Page({
  data: {
    session: {}, store: {}, stores: [], storeLabels: ["请选择门店"], storeIndex: 0, loadingStores: false,
    name: "", birthDate: "", notes: "", today: businessToday(), consent: false, captureReady: false,
    busy: false, message: "", error: false
  },
  onLoad() {
    const session = requireSession(["store", "teacher"]);
    if (!session) return;
    this.setData({ session, today: businessToday() });
    if (session.role === "store") {
      const store = getSelectedStore(session);
      if (!store || !store.id) return wx.reLaunch({ url: "/pages/home/index" });
      this.setData({ store: businessStore(store) });
      return;
    }
    this.loadTeacherStores();
  },
  onUnload() {
    this._storeRequestEpoch = (this._storeRequestEpoch || 0) + 1;
  },
  async loadTeacherStores() {
    const requestEpoch = (this._storeRequestEpoch || 0) + 1;
    this._storeRequestEpoch = requestEpoch;
    this.setData({ loadingStores: true, stores: [], storeLabels: ["请选择门店"], storeIndex: 0, store: {}, message: "", error: false });
    try {
      const result = await callFace("getTeacherBusinessContext");
      if (requestEpoch !== this._storeRequestEpoch) return;
      const stores = (result.stores || []).map(businessStore).filter((item) => item.id && item.name);
      this.setData({
        stores,
        storeLabels: ["请选择门店", ...stores.map((item) => `${item.name} · ${item.code || item.id}`)],
        message: stores.length ? "请先选择本次建立客户的门店" : "暂无可办理的活跃门店",
        error: !stores.length
      });
    } catch (error) {
      if (requestEpoch === this._storeRequestEpoch) {
        this.setData({ stores: [], storeLabels: ["请选择门店"], storeIndex: 0, store: {}, message: error.message || "可办理门店读取失败", error: true });
      }
    } finally {
      if (requestEpoch === this._storeRequestEpoch) this.setData({ loadingStores: false });
    }
  },
  selectStore(event) {
    if (this.data.busy) return;
    const pickerIndex = Number(event.detail.value);
    const index = pickerIndex - 1;
    const store = this.data.stores[index];
    if (!store || !store.id) return;
    const camera = this.selectComponent("#customerCamera");
    if (camera) camera.reset();
    setSelectedStore(store, this.data.session);
    this._requestId = "";
    this.setData({
      store, storeIndex: pickerIndex,
      name: "", birthDate: "", notes: "", consent: false, captureReady: false,
      message: `已选择 ${store.name}，请填写客户资料`, error: false
    });
  },
  inputName(event) { this.setData({ name: event.detail.value }); this._requestId = ""; },
  inputBirthday(event) { this.setData({ birthDate: event.detail.value }); this._requestId = ""; },
  inputNotes(event) { this.setData({ notes: event.detail.value }); this._requestId = ""; },
  toggleConsent() { this.setData({ consent: !this.data.consent }); },
  captureChanged(event) { this.setData({ captureReady: event.detail.ready === true, message: "", error: false }); this._requestId = ""; },
  async submit() {
    if (this.data.busy) return;
    if (!this.data.store.id) return this.setData({ message: "请先选择本次建立客户的门店", error: true });
    const name = String(this.data.name || "").trim();
    if (!name || !this.data.birthDate) return this.setData({ message: "姓名和生日必须填写", error: true });
    if (!this.data.consent) return this.setData({ message: "必须取得客户明确授权", error: true });
    const capture = this.selectComponent("#customerCamera").getCapture();
    if (!capture) return this.setData({ message: "必须完成现场拍照", error: true });
    this._requestId = this._requestId || requestId();
    this.setData({ busy: true, message: "正在由服务端检测照片质量与活体…", error: false });
    try {
      await callFace("validateCapture", { storeId: this.data.store.id, imageBase64: capture.imageBase64 });
      this.setData({ message: "照片检测通过，正在建立人脸档案并写入客户资料…" });
      const result = await callFace("registerCustomer", {
        storeId: this.data.store.id, customerName: name, birthDate: this.data.birthDate,
        notes: String(this.data.notes || "").trim(), consent: true,
        imageBase64: capture.imageBase64, clientRequestId: this._requestId
      });
      const savedCustomer = result.customer || {};
      const code = String(savedCustomer.customerCode || "").trim();
      const facePersonId = String(savedCustomer.facePersonId || "").trim();
      const photoFileId = String(savedCustomer.photoFileId || "").trim();
      if (!code || !facePersonId || !photoFileId) {
        throw new Error("服务端未读回客户编号、人脸标识和照片引用，禁止显示创建成功");
      }
      this.selectComponent("#customerCamera").reset();
      this.setData({ name: "", birthDate: "", notes: "", consent: false, message: "客户已完整建立，正在打开客户主页…", error: false });
      this._requestId = "";
      wx.redirectTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
    } catch (error) { this.setData({ message: error.message || "客户建立失败；不会显示半成品成功", error: true }); }
    finally { this.setData({ busy: false }); }
  }
});

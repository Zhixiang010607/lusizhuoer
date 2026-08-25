const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore } = require("../../services/session");
const { businessToday } = require("../../services/query-tools");

function requestId() { return `mp_customer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`.slice(0, 64); }

Page({
  data: { session: {}, store: {}, name: "", birthDate: "", notes: "", today: businessToday(), consent: false, captureReady: false, busy: false, message: "", error: false },
  onLoad() {
    const session = requireSession(["store", "teacher"]);
    if (!session) return;
    const store = getSelectedStore(session);
    if (!store) return wx.reLaunch({ url: "/pages/home/index" });
    this.setData({ session, store, today: businessToday() });
  },
  inputName(event) { this.setData({ name: event.detail.value }); this._requestId = ""; },
  inputBirthday(event) { this.setData({ birthDate: event.detail.value }); this._requestId = ""; },
  inputNotes(event) { this.setData({ notes: event.detail.value }); this._requestId = ""; },
  toggleConsent() { this.setData({ consent: !this.data.consent }); },
  captureChanged(event) { this.setData({ captureReady: event.detail.ready === true, message: "", error: false }); this._requestId = ""; },
  async submit() {
    if (this.data.busy) return;
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
      const code = result.customer && result.customer.customerCode;
      if (!code) throw new Error("服务端没有返回客户编号，禁止显示创建成功");
      this.selectComponent("#customerCamera").reset();
      this.setData({ name: "", birthDate: "", notes: "", consent: false, message: "客户已完整建立，正在打开客户主页…", error: false });
      this._requestId = "";
      wx.redirectTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
    } catch (error) { this.setData({ message: error.message || "客户建立失败；不会显示半成品成功", error: true }); }
    finally { this.setData({ busy: false }); }
  }
});

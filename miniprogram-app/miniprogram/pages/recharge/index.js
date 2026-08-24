const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore } = require("../../services/session");
const submission = require("../../services/submission");

function product(value) {
  return {
    productId: String(value.productId || ""), productCode: String(value.productCode || ""), productName: String(value.productName || ""),
    purchasedCount: Number(value.purchasedCount || 0), remainingCount: Number(value.remainingCount || 0)
  };
}
function teacher(value) {
  return { teacherId: String(value.teacherId || ""), teacherCode: String(value.teacherCode || ""), teacherName: String(value.teacherName || "") };
}

Page({
  data: {
    session: {}, store: {}, refund: false, customer: null, products: [], productLabels: [], productIndex: -1, selectedProduct: null,
    teachers: [], teacherLabels: [], teacherIndex: 0, selectedTeacher: null, unitCount: "", note: "", loadingOptions: false,
    busy: false, locked: false, recovering: false, ready: false, message: "", error: false
  },
  onLoad(options) {
    const session = requireSession(["store", "teacher"]);
    if (!session) return;
    const store = getSelectedStore(session);
    if (!store) return wx.reLaunch({ url: "/pages/home/index" });
    this.setData({ session, store, refund: String(options.mode || "NEW").toUpperCase() === "REFUND" });
    this.loadTeachers();
    if (!this.data.refund) this.loadProducts();
    if (submission.read("RECHARGE")) {
      this.setData({ locked: true, message: "检测到上一次充值或退费请求尚未确认，已锁定新提交。" });
      this.recoverPending();
    }
  },
  customerChanged() { this.setData({ customer: null, products: this.data.refund ? [] : this.data.products, selectedProduct: null, productIndex: -1 }); this.syncReady(); },
  async customerConfirmed(event) {
    const customer = event.detail.customer;
    this.setData({ customer, message: `已确认 ${customer.customerName}`, error: false, selectedProduct: null, productIndex: -1 });
    if (this.data.refund) await this.loadProducts();
    this.syncReady();
  },
  async loadTeachers() {
    try {
      const result = await callFace("listActiveTeachers", { storeId: this.data.store.id });
      const values = (result.teachers || []).map(teacher).filter((item) => item.teacherId);
      if (this.data.session.role === "teacher") {
        const mineIndex = values.findIndex((item) => item.teacherId === String(this.data.session.teacherId || ""));
        const mine = mineIndex >= 0 ? values[mineIndex] : null;
        this.setData({ teachers: values, teacherLabels: values.map((item) => `${item.teacherName} · ${item.teacherCode}`), selectedTeacher: mine, teacherIndex: Math.max(0, mineIndex) });
      } else {
        const options = [{ teacherId: "", teacherCode: "", teacherName: "不指定业务老师" }, ...values];
        this.setData({ teachers: options, teacherLabels: options.map((item) => item.teacherId ? `${item.teacherName} · ${item.teacherCode}` : item.teacherName), selectedTeacher: options[0], teacherIndex: 0 });
      }
      this.syncReady();
    } catch (error) { this.setData({ message: error.message || "老师列表读取失败", error: true }); }
  },
  async loadProducts() {
    this.setData({ loadingOptions: true, selectedProduct: null, productIndex: -1 });
    try {
      const result = this.data.refund
        ? await callFace("getCustomerProductBalances", { storeId: this.data.store.id, customerCode: this.data.customer.customerCode })
        : await callFace("listActiveProducts", { storeId: this.data.store.id });
      const values = (this.data.refund ? (result.balances || []) : (result.products || [])).map(product)
        .filter((item) => item.productId && (!this.data.refund || item.purchasedCount > 0));
      this.setData({
        products: values,
        productLabels: values.map((item) => this.data.refund ? `${item.productName}（剩余 ${item.remainingCount}，可退 ${item.purchasedCount}）` : `${item.productName} · ${item.productCode}`)
      });
    } catch (error) { this.setData({ products: [], productLabels: [], message: error.message || "项目读取失败", error: true }); }
    finally { this.setData({ loadingOptions: false }); this.syncReady(); }
  },
  selectProduct(event) { const index = Number(event.detail.value); this.setData({ productIndex: index, selectedProduct: this.data.products[index] || null }); this.syncReady(); },
  selectTeacher(event) { const index = Number(event.detail.value); this.setData({ teacherIndex: index, selectedTeacher: this.data.teachers[index] || null }); this.syncReady(); },
  inputCount(event) { this.setData({ unitCount: event.detail.value }); this.syncReady(); },
  inputNote(event) { this.setData({ note: event.detail.value }); },
  syncReady() {
    const count = Number(this.data.unitCount);
    const validCount = Number.isInteger(count) && count >= 1 && count <= 999;
    const refundAllowed = !this.data.refund || !this.data.selectedProduct || count <= this.data.selectedProduct.purchasedCount;
    this.setData({ ready: Boolean(this.data.customer && this.data.selectedProduct && this.data.selectedTeacher && validCount && refundAllowed && !this.data.locked) });
  },
  async submit() {
    if (this.data.busy || !this.data.ready) return;
    const count = Number(this.data.unitCount);
    const payload = {
      storeId: this.data.store.id, applicationType: this.data.refund ? "REFUND" : "NEW", customerCode: this.data.customer.customerCode,
      productId: this.data.selectedProduct.productId, teacherId: this.data.selectedTeacher.teacherId, unitCount: count, message: String(this.data.note || "").trim()
    };
    let intent;
    try { intent = submission.begin("RECHARGE", payload); }
    catch (error) { return this.setData({ locked: true, message: error.message, error: true }); }
    this.setData({ busy: true, message: "正在提交；请勿退出或重复点击…", error: false });
    let result = null;
    try {
      result = await callFace("createRechargeApplication", { ...payload, clientRequestId: intent.clientRequestId });
      if (String(result.recordStatus || "") !== "PENDING" || !result.rechargeId || !result.rechargeCode) throw new Error("服务端未返回完整待审核单据，已禁止显示成功");
      submission.clear("RECHARGE");
      this.setData({ locked: false, message: `${this.data.refund ? '退费' : '充值'}单 ${result.rechargeCode} 已提交，等待总部审核。`, error: false, unitCount: "", note: "" });
      wx.showModal({ title: "提交成功", content: `${result.rechargeCode}\n状态：待审核`, showCancel: false });
    } catch (error) {
      submission.markUncertain("RECHARGE");
      await this.recoverAfterError(error, Boolean(result));
    } finally { this.setData({ busy: false }); this.syncReady(); }
  },
  async recoverAfterError(error, hadResult) {
    if (!error.submissionUncertain && !hadResult) {
      try {
        const recovered = await submission.recover("RECHARGE");
        if (recovered.found && recovered.complete) return this.showRecovered(recovered);
        submission.clear("RECHARGE");
        return this.setData({ locked: false, message: error.message || "申请未写入，可修正后重试", error: true });
      } catch (_) { /* keep the lock when the confirmation check itself fails */ }
    }
    this.setData({ locked: true, message: "提交响应中断，数据库可能已写入。为防止重复充值或退费，已锁定重复提交。", error: true });
    await this.recoverPending();
  },
  showRecovered(result) {
    this.setData({ locked: false, message: `已找到上次单据 ${result.rechargeCode}，不会重复提交。`, error: false });
    wx.showModal({ title: "已恢复原单据", content: `${result.rechargeCode}\n状态：${result.recordStatus}`, showCancel: false });
    this.syncReady();
  },
  async recoverPending() {
    if (this.data.recovering || !submission.read("RECHARGE")) return;
    this.setData({ recovering: true, locked: true, message: "正在从数据库检查上次提交结果…", error: false });
    try {
      const result = await submission.recover("RECHARGE");
      if (result.found && result.complete) return this.showRecovered(result);
      if (result.found) return this.setData({ message: "上次单据已写入但状态不完整，已继续锁定，请联系管理员。", error: true });
      this.setData({ message: "数据库暂未找到结果，原请求可能仍在执行。请稍后再检查，不要重复提交。", error: true });
    } catch (error) { this.setData({ message: `${error.message || '暂时无法检查'}；已继续锁定重复提交。`, error: true }); }
    finally { this.setData({ recovering: false }); }
  }
});

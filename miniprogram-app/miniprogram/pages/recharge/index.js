const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore, setSelectedStore } = require("../../services/session");
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
function businessStore(value) {
  value = value || {};
  return {
    id: String(value.storeId || value.id || ""),
    code: String(value.storeCode || value.code || ""),
    name: String(value.storeName || value.name || "")
  };
}
function submittedOrderHint(session, refund) {
  if (session && session.role === "teacher") {
    return `请返回“我的工作台”，在“本人业务明细”的“${refund ? '退费' : '充值'}”分类中打开`;
  }
  return "请从充值查询进入";
}

function orderUrl(refund, result, intent = {}) {
  const recordId = String(result.rechargeId || "");
  const recordCode = String(result.rechargeCode || "");
  if (!recordId || !recordCode) return "";
  const category = refund ? "REFUND" : "RECHARGE";
  const acknowledgement = intent.clientRequestId ? `&submissionClientRequestId=${encodeURIComponent(intent.clientRequestId)}` : "";
  return `/pages/order-detail/index?type=recharge&category=${category}&recordId=${encodeURIComponent(recordId)}&recordCode=${encodeURIComponent(recordCode)}${acknowledgement}`;
}

Page({
  data: {
    session: {}, store: {}, stores: [], storeLabels: ["请选择门店"], storeIndex: 0, loadingStores: false,
    refund: false, customer: null, products: [], productLabels: [], productIndex: -1, selectedProduct: null,
    teachers: [], teacherLabels: [], teacherIndex: 0, selectedTeacher: null, teacherOptionsReady: false, unitCount: "", note: "", loadingOptions: false,
    busy: false, locked: false, recovering: false, ready: false, message: "", error: false
  },
  onLoad(options) {
    const session = requireSession(["store", "teacher"]);
    if (!session) return;
    const refund = String(options.mode || "NEW").toUpperCase() === "REFUND";
    this.setData({ session, refund });
    if (session.role === "store") {
      const store = getSelectedStore(session);
      if (!store || !store.id) return wx.reLaunch({ url: "/pages/home/index" });
      this.setData({ store: businessStore(store) });
      this.loadTeachers();
      if (!refund) this.loadProducts();
    } else {
      this.loadTeacherStores();
    }
    if (submission.read("RECHARGE")) {
      this.setData({ locked: true, message: "检测到上一次充值或退费请求尚未确认，已锁定新提交。" });
      this.recoverPending();
    }
  },
  onUnload() {
    this._storeRequestEpoch = (this._storeRequestEpoch || 0) + 1;
    this._teacherRequestEpoch = (this._teacherRequestEpoch || 0) + 1;
    this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
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
        ...(!this.data.locked ? {
          message: stores.length ? "请先选择本次业务的发生门店" : "暂无可办理的活跃门店",
          error: !stores.length
        } : {})
      });
    } catch (error) {
      if (requestEpoch === this._storeRequestEpoch) {
        this.setData({
          stores: [], storeLabels: ["请选择门店"], storeIndex: 0, store: {},
          ...(!this.data.locked ? { message: error.message || "可办理门店读取失败", error: true } : {})
        });
      }
    } finally {
      if (requestEpoch === this._storeRequestEpoch) this.setData({ loadingStores: false });
    }
  },
  selectStore(event) {
    if (this.data.busy || this.data.locked) return;
    const pickerIndex = Number(event.detail.value);
    const index = pickerIndex - 1;
    const store = this.data.stores[index];
    if (!store || !store.id || store.id === String(this.data.store.id || "")) return;
    setSelectedStore(store, this.data.session);
    this._teacherRequestEpoch = (this._teacherRequestEpoch || 0) + 1;
    this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
    this.setData({
      store, storeIndex: pickerIndex,
      customer: null,
      teachers: [], teacherLabels: [], teacherIndex: 0, selectedTeacher: null, teacherOptionsReady: false,
      products: [], productLabels: [], productIndex: -1, selectedProduct: null,
      unitCount: "", note: "", loadingOptions: false, ready: false,
      message: `已选择 ${store.name}，请确认客户`, error: false
    });
    this.loadTeachers();
    if (!this.data.refund) this.loadProducts();
  },
  customerChanged() {
    if (this.data.refund) this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
    this.setData({
      customer: null, products: this.data.refund ? [] : this.data.products,
      productLabels: this.data.refund ? [] : this.data.productLabels,
      selectedProduct: null, productIndex: -1,
      unitCount: "", note: "", ready: false,
      loadingOptions: this.data.refund ? false : this.data.loadingOptions,
      message: "", error: false
    });
    this.syncReady();
  },
  async customerConfirmed(event) {
    const customer = event.detail.customer;
    this.setData({
      customer, message: `已确认 ${customer.customerName}`, error: false,
      selectedProduct: null, productIndex: -1, unitCount: "", note: "", ready: false
    });
    if (this.data.refund) await this.loadProducts(customer.customerCode);
    if (this.data.session.role === "teacher" && this.data.teacherOptionsReady && !this.data.selectedTeacher) {
      this.setData({ message: "当前老师不在该门店的可办理老师名单中，已禁止提交", error: true });
    }
    this.syncReady();
  },
  async loadTeachers() {
    const storeId = String(this.data.store.id || "");
    if (!storeId) return;
    const requestEpoch = (this._teacherRequestEpoch || 0) + 1;
    this._teacherRequestEpoch = requestEpoch;
    this.setData({ teacherOptionsReady: false });
    try {
      const result = await callFace("listActiveTeachers", { storeId });
      if (requestEpoch !== this._teacherRequestEpoch || String(this.data.store.id || "") !== storeId) return;
      const values = (result.teachers || []).map(teacher).filter((item) => item.teacherId);
      if (this.data.session.role === "teacher") {
        const mineIndex = values.findIndex((item) => item.teacherId === String(this.data.session.teacherId || ""));
        const mine = mineIndex >= 0 ? values[mineIndex] : null;
        this.setData({ teachers: values, teacherLabels: values.map((item) => `${item.teacherName} · ${item.teacherCode}`), selectedTeacher: mine, teacherIndex: Math.max(0, mineIndex), teacherOptionsReady: true });
        if (!mine) this.setData({ message: "当前老师不在该门店的可办理老师名单中，已禁止提交", error: true });
      } else {
        const options = [{ teacherId: "", teacherCode: "", teacherName: "不指定业务老师" }, ...values];
        this.setData({ teachers: options, teacherLabels: options.map((item) => item.teacherId ? `${item.teacherName} · ${item.teacherCode}` : item.teacherName), selectedTeacher: options[0], teacherIndex: 0, teacherOptionsReady: true });
      }
      this.syncReady();
    } catch (error) {
      if (requestEpoch === this._teacherRequestEpoch && String(this.data.store.id || "") === storeId) {
        this.setData({ teacherOptionsReady: true, message: error.message || (this.data.session.role === "teacher" ? "当前老师信息读取失败，已禁止提交" : "老师列表读取失败"), error: true });
      }
    }
  },
  async loadProducts(expectedCustomerCode = String(this.data.customer?.customerCode || "")) {
    const refund = this.data.refund;
    const storeId = String(this.data.store.id || "");
    const customerCode = String(expectedCustomerCode || "");
    if (refund && !customerCode) {
      this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
      this.setData({ products: [], productLabels: [], selectedProduct: null, productIndex: -1, loadingOptions: false });
      this.syncReady();
      return;
    }
    const requestEpoch = (this._productRequestEpoch || 0) + 1;
    this._productRequestEpoch = requestEpoch;
    this.setData({ loadingOptions: true, selectedProduct: null, productIndex: -1 });
    try {
      const result = refund
        ? await callFace("getCustomerProductBalances", { storeId, customerCode })
        : await callFace("listActiveProducts", { storeId });
      if (requestEpoch !== this._productRequestEpoch || (refund && String(this.data.customer?.customerCode || "") !== customerCode)) return;
      const values = (refund ? (result.balances || []) : (result.products || [])).map(product)
        .filter((item) => item.productId && (!refund || item.purchasedCount > 0));
      this.setData({
        products: values,
        productLabels: values.map((item) => refund ? `${item.productName}（剩余 ${item.remainingCount}，可退 ${item.purchasedCount}）` : `${item.productName} · ${item.productCode}`)
      });
    } catch (error) {
      if (requestEpoch === this._productRequestEpoch && (!refund || String(this.data.customer?.customerCode || "") === customerCode)) {
        this.setData({ products: [], productLabels: [], message: error.message || (refund ? "该客户可退余额读取失败" : "项目读取失败"), error: true });
      }
    } finally {
      if (requestEpoch === this._productRequestEpoch && (!refund || String(this.data.customer?.customerCode || "") === customerCode)) {
        this.setData({ loadingOptions: false });
        this.syncReady();
      }
    }
  },
  selectProduct(event) { const index = Number(event.detail.value); this.setData({ productIndex: index, selectedProduct: this.data.products[index] || null }); this.syncReady(); },
  selectTeacher(event) { const index = Number(event.detail.value); this.setData({ teacherIndex: index, selectedTeacher: this.data.teachers[index] || null }); this.syncReady(); },
  inputCount(event) { this.setData({ unitCount: event.detail.value }); this.syncReady(); },
  inputNote(event) { this.setData({ note: event.detail.value }); },
  syncReady() {
    const count = Number(this.data.unitCount);
    const validCount = Number.isInteger(count) && count >= 1 && count <= 999;
    const refundAllowed = !this.data.refund || !this.data.selectedProduct || count <= this.data.selectedProduct.purchasedCount;
    this.setData({ ready: Boolean(this.data.store.id && this.data.customer && this.data.selectedProduct && this.data.selectedTeacher && validCount && refundAllowed && !this.data.locked) });
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
      const confirmedIntent = submission.confirm("RECHARGE", result.rechargeId);
      this.setData({ locked: false, message: `${this.data.refund ? '退费' : '充值'}单 ${result.rechargeCode} 已提交，等待总部审核。`, error: false, unitCount: "", note: "" });
      this.openSubmittedOrder(result, confirmedIntent);
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
    const confirmedIntent = submission.confirm("RECHARGE", result.rechargeId);
    this.setData({ locked: false, message: `已找到上次单据 ${result.rechargeCode}，不会重复提交。`, error: false });
    this.openSubmittedOrder(result, confirmedIntent);
    this.syncReady();
  },
  openSubmittedOrder(result, intent) {
    const url = orderUrl(this.data.refund || String(result.rechargeType || "").toUpperCase() === "REFUND", result, intent);
    const refund = this.data.refund || String(result.rechargeType || "").toUpperCase() === "REFUND";
    const hint = submittedOrderHint(this.data.session, refund);
    if (!url) {
      this.setData({ message: `单据已写入，但服务端没有返回完整工单定位信息；${hint}，禁止重复提交。`, error: true });
      return;
    }
    wx.redirectTo({
      url,
      fail: () => {
        this.setData({ locked: true, message: `${result.rechargeCode} 已写入，但工单详情打开失败；原提交锁仍保留，${hint}，禁止重复提交。`, error: true });
        wx.showModal({ title: "工单已提交", content: `${result.rechargeCode}\n原提交锁仍保留，${hint}详情`, showCancel: false });
      }
    });
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

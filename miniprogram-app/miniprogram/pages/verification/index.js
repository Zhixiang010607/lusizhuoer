const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore, setSelectedStore } = require("../../services/session");
const submission = require("../../services/submission");

function teacher(value) { return { teacherId: String(value.teacherId || ""), teacherCode: String(value.teacherCode || ""), teacherName: String(value.teacherName || "") }; }
function businessStore(value) {
  value = value || {};
  return {
    id: String(value.storeId || value.id || ""),
    code: String(value.storeCode || value.code || ""),
    name: String(value.storeName || value.name || "")
  };
}
function product(value) {
  return {
    productId: String(value.productId || ""), productCode: String(value.productCode || ""), productName: String(value.productName || ""),
    remainingCount: Number(value.remainingCount || 0), availableCount: Number(value.availableCount || 0)
  };
}
function submittedOrderHint(session, experience) {
  if (session && session.role === "teacher") {
    return `请返回“我的工作台”，在“本人业务明细”的“${experience ? '体验' : '核销'}”分类中打开`;
  }
  return "请从核销查询进入";
}

function orderUrl(experience, result, intent = {}) {
  const recordId = String(result.verificationId || "");
  const recordCode = String(result.verificationCode || "");
  if (!recordId || !recordCode) return "";
  const category = experience ? "EXPERIENCE" : "VERIFICATION";
  const acknowledgement = intent.clientRequestId ? `&submissionClientRequestId=${encodeURIComponent(intent.clientRequestId)}` : "";
  return `/pages/order-detail/index?type=verification&category=${category}&recordId=${encodeURIComponent(recordId)}&recordCode=${encodeURIComponent(recordCode)}${acknowledgement}`;
}

Page({
  data: {
    session: {}, store: {}, stores: [], storeLabels: ["请选择门店"], storeIndex: 0, loadingStores: false,
    experience: false, customer: null, teachers: [], teacherLabels: [], teacherIndex: -1, selectedTeacher: null, teacherOptionsReady: false,
    products: [], productLabels: [], productIndex: -1, selectedProduct: null, unitCount: "", unitCountMax: 0, unitCountValid: false, note: "", captureReady: false, faceVerified: false,
    faceRequestId: "", faceEvidenceToken: "", faceMessage: "", faceError: false, loadingOptions: false, verifying: false,
    busy: false, locked: false, recovering: false, ready: false, message: "", error: false
  },
  onLoad(options) {
    const session = requireSession(["store", "teacher"]);
    if (!session) return;
    const experience = String(options.mode || "NORMAL").toUpperCase() === "EXPERIENCE";
    if (experience && session.role !== "teacher") {
      wx.showModal({ title: "无权办理", content: "体验核销只能由老师账号赠送。", showCancel: false, complete: () => wx.reLaunch({ url: "/pages/home/index" }) });
      return;
    }
    this.setData({ session, experience });
    if (session.role === "store") {
      const store = getSelectedStore(session);
      if (!store || !store.id) return wx.reLaunch({ url: "/pages/home/index" });
      this.setData({ store: businessStore(store) });
      this.loadTeachers();
    } else {
      this.loadTeacherStores();
    }
    if (submission.read("VERIFICATION")) {
      this.setData({ locked: true, message: "检测到上一次核销尚未确认，已禁止再次扣减。" });
      this.recoverPending();
    }
  },
  onUnload() {
    this._storeRequestEpoch = (this._storeRequestEpoch || 0) + 1;
    this._teacherRequestEpoch = (this._teacherRequestEpoch || 0) + 1;
    this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
    this._faceRequestEpoch = (this._faceRequestEpoch || 0) + 1;
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
          message: stores.length ? "请先选择本次核销的发生门店" : "暂无可办理的活跃门店",
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
    const camera = this.selectComponent("#verificationCamera");
    if (camera) camera.reset();
    setSelectedStore(store, this.data.session);
    this._teacherRequestEpoch = (this._teacherRequestEpoch || 0) + 1;
    this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
    this._faceRequestEpoch = (this._faceRequestEpoch || 0) + 1;
    this.setData({
      store, storeIndex: pickerIndex,
      customer: null,
      teachers: [], teacherLabels: [], teacherIndex: -1, selectedTeacher: null, teacherOptionsReady: false,
      products: [], productLabels: [], productIndex: -1, selectedProduct: null, unitCount: "", unitCountMax: 0, unitCountValid: false,
      note: "", captureReady: false, faceVerified: false, faceRequestId: "", faceEvidenceToken: "",
      faceMessage: "", faceError: false, loadingOptions: false, verifying: false, ready: false,
      message: `已选择 ${store.name}，请确认客户`, error: false
    });
    this.loadTeachers();
  },
  customerChanged() {
    this.setData({ customer: null, message: "", error: false });
    this.resetBusinessSelection({ resetTeacher: this.data.session.role === "store", clearNote: true });
  },
  async customerConfirmed(event) {
    this.setData({ customer: event.detail.customer, message: `已确认 ${event.detail.customer.customerName}`, error: false });
    this.resetBusinessSelection({ resetTeacher: this.data.session.role === "store", clearNote: true });
    await this.loadProducts();
    if (this.data.session.role === "teacher" && this.data.teacherOptionsReady && !this.data.selectedTeacher) {
      this.setData({ message: "当前老师不在该门店的可办理老师名单中，已禁止核销", error: true });
    }
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
      const mineIndex = this.data.session.role === "teacher"
        ? values.findIndex((item) => item.teacherId === String(this.data.session.teacherId || ""))
        : -1;
      const mine = mineIndex >= 0 ? values[mineIndex] : null;
      this.setData({ teachers: values, teacherLabels: values.map((item) => `${item.teacherName} · ${item.teacherCode}`), selectedTeacher: mine, teacherIndex: mineIndex, teacherOptionsReady: true });
      if (this.data.session.role === "teacher" && !mine) {
        this.setData({ message: "当前老师不在该门店的可办理老师名单中，已禁止核销", error: true });
      }
      if (this.data.customer && this.data.experience) await this.loadProducts();
      this.syncReady();
    } catch (error) {
      if (requestEpoch === this._teacherRequestEpoch && String(this.data.store.id || "") === storeId) {
        this.setData({ teacherOptionsReady: true, message: error.message || (this.data.session.role === "teacher" ? "当前老师信息读取失败，已禁止核销" : "老师列表读取失败"), error: true });
      }
    }
  },
  async loadProducts() {
    if (!this.data.customer || (this.data.experience && !this.data.selectedTeacher)) return;
    const experience = this.data.experience;
    const storeId = String(this.data.store.id || "");
    const customerCode = String(this.data.customer.customerCode || "");
    const teacherId = String(this.data.selectedTeacher?.teacherId || "");
    const requestEpoch = (this._productRequestEpoch || 0) + 1;
    this._productRequestEpoch = requestEpoch;
    this.setData({ loadingOptions: true, products: [], productLabels: [], selectedProduct: null, productIndex: -1, unitCount: "", unitCountMax: 0, unitCountValid: false });
    this.resetFace();
    try {
      const result = experience
        ? await callFace("getTeacherExperienceEntitlements", { storeId, teacherId })
        : await callFace("getCustomerProductBalances", { storeId, customerCode });
      if (!this.isCurrentProductRequest(requestEpoch, customerCode, teacherId, experience)) return;
      const source = experience ? (result.entitlements || []) : (result.balances || []);
      const values = source.map(product).filter((item) => item.productId && (experience ? item.availableCount > 0 : item.remainingCount > 0));
      this.setData({
        products: values,
        productLabels: values.map((item) => `${item.productName}（${experience ? '老师可用' : '客户剩余'} ${experience ? item.availableCount : item.remainingCount} 次）`)
      });
    } catch (error) {
      if (this.isCurrentProductRequest(requestEpoch, customerCode, teacherId, experience)) {
        this.setData({ message: error.message || (experience ? "当前老师体验额度读取失败" : "该客户可核销余额读取失败"), error: true });
      }
    } finally {
      if (this.isCurrentProductRequest(requestEpoch, customerCode, teacherId, experience)) {
        this.setData({ loadingOptions: false });
        this.syncReady();
      }
    }
  },
  isCurrentProductRequest(requestEpoch, customerCode, teacherId, experience) {
    return requestEpoch === this._productRequestEpoch
      && this.data.experience === experience
      && String(this.data.customer?.customerCode || "") === customerCode
      && (!experience || String(this.data.selectedTeacher?.teacherId || "") === teacherId);
  },
  selectTeacher(event) {
    const index = Number(event.detail.value);
    this.setData({ teacherIndex: index, selectedTeacher: this.data.teachers[index] || null });
    if (this.data.experience) {
      this.resetBusinessSelection();
      if (this.data.customer && this.data.selectedTeacher) this.loadProducts();
    } else {
      this.resetFace();
      this.syncReady();
    }
  },
  selectProduct(event) {
    const index = Number(event.detail.value);
    const selectedProduct = this.data.products[index] || null;
    const available = selectedProduct
      ? Number(this.data.experience ? selectedProduct.availableCount : selectedProduct.remainingCount)
      : 0;
    this.setData({
      productIndex: index,
      selectedProduct,
      unitCount: "",
      unitCountMax: Math.min(999, Math.max(0, Math.trunc(available))),
      unitCountValid: false
    });
    this.resetFace();
    this.syncReady();
  },
  inputUnitCount(event) {
    const value = String(event.detail.value || "").replace(/\D/g, "").slice(0, 3);
    this._faceRequestEpoch = (this._faceRequestEpoch || 0) + 1;
    this.setData({
      unitCount: value,
      unitCountValid: false,
      faceVerified: false,
      faceRequestId: "",
      faceEvidenceToken: "",
      faceMessage: "",
      faceError: false,
      verifying: false,
      ready: false
    });
    this.syncReady();
  },
  inputNote(event) { this.setData({ note: event.detail.value }); },
  captureChanged(event) { this.setData({ captureReady: event.detail.ready === true }); this.resetFace(false); },
  resetBusinessSelection({ resetTeacher = false, clearNote = false } = {}) {
    this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
    this.setData({
      products: [], productLabels: [], productIndex: -1, selectedProduct: null, unitCount: "", unitCountMax: 0, unitCountValid: false,
      loadingOptions: false, ready: false,
      ...(clearNote ? { note: "" } : {}),
      ...(resetTeacher ? { teacherIndex: -1, selectedTeacher: null } : {})
    });
    this.resetFace();
  },
  resetFace(resetCamera = true) {
    this._faceRequestEpoch = (this._faceRequestEpoch || 0) + 1;
    if (resetCamera) {
      const camera = this.selectComponent("#verificationCamera");
      if (camera) camera.reset();
    }
    this.setData({
      faceVerified: false, faceRequestId: "", faceEvidenceToken: "", faceMessage: "", faceError: false,
      verifying: false, ready: false,
      ...(resetCamera ? { captureReady: false } : {})
    });
    this.syncReady();
  },
  async verifyFace() {
    if (this.data.verifying) return;
    const capture = this.selectComponent("#verificationCamera").getCapture();
    const unitCount = Number(this.data.unitCount);
    if (!capture || !this.data.customer || !this.data.selectedProduct || !this.data.selectedTeacher
        || !Number.isInteger(unitCount) || unitCount < 1 || unitCount > Number(this.data.unitCountMax || 0)) return;
    const identity = {
      customerCode: String(this.data.customer.customerCode || ""),
      productId: String(this.data.selectedProduct?.productId || ""),
      teacherId: String(this.data.selectedTeacher?.teacherId || ""),
      unitCount
    };
    const requestEpoch = (this._faceRequestEpoch || 0) + 1;
    this._faceRequestEpoch = requestEpoch;
    this.setData({ verifying: true, faceVerified: false, faceMessage: "正在由服务端完成客户 1:1 人脸与活体验证…", faceError: false });
    try {
      const result = await callFace("verifyCustomerFace", {
        storeId: this.data.store.id, customerCode: identity.customerCode, imageBase64: capture.imageBase64,
        thumbnailBase64: capture.thumbnailBase64, imageWidth: capture.imageWidth, imageHeight: capture.imageHeight
      });
      if (!this.isCurrentFaceRequest(requestEpoch, identity)) return;
      const token = String(result.faceEvidenceToken || "");
      const requestId = String(result.requestId || "");
      if (!result.matched || !requestId || !/^[0-9a-f]{48}$/.test(token)) throw new Error("客户人脸验证或现场照片凭证不完整，禁止核销");
      this.setData({ faceVerified: true, faceRequestId: requestId, faceEvidenceToken: token, faceMessage: `客户 1:1 人脸验证通过（${Number(result.score || 0)} 分）`, faceError: false });
    } catch (error) {
      if (this.isCurrentFaceRequest(requestEpoch, identity)) {
        this.setData({ faceVerified: false, faceRequestId: "", faceEvidenceToken: "", faceMessage: error.message || "人脸验证未通过", faceError: true });
      }
    } finally {
      if (this.isCurrentFaceRequest(requestEpoch, identity)) {
        this.setData({ verifying: false });
        this.syncReady();
      }
    }
  },
  isCurrentFaceRequest(requestEpoch, identity) {
    return requestEpoch === this._faceRequestEpoch
      && String(this.data.customer?.customerCode || "") === identity.customerCode
      && String(this.data.selectedProduct?.productId || "") === identity.productId
      && String(this.data.selectedTeacher?.teacherId || "") === identity.teacherId
      && Number(this.data.unitCount) === identity.unitCount;
  },
  syncReady() {
    const unitCount = Number(this.data.unitCount);
    const countReady = Number.isInteger(unitCount) && unitCount >= 1 && unitCount <= Number(this.data.unitCountMax || 0);
    this.setData({
      unitCountValid: countReady,
      ready: Boolean(this.data.store.id && this.data.customer && this.data.selectedProduct && this.data.selectedTeacher && countReady && this.data.faceVerified && this.data.faceRequestId && this.data.faceEvidenceToken && !this.data.locked)
    });
  },
  async submit() {
    if (this.data.busy || !this.data.ready) return;
    const unitCount = Number(this.data.unitCount);
    if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > Number(this.data.unitCountMax || 0)) {
      return this.setData({ message: `核销次数必须由办理人员填写，并且是 1 至 ${this.data.unitCountMax || 0} 的整数`, error: true });
    }
    const identity = {
      storeId: this.data.store.id, customerCode: this.data.customer.customerCode, productId: this.data.selectedProduct.productId,
      unitCount, teacherId: this.data.selectedTeacher.teacherId, verificationType: this.data.experience ? "EXPERIENCE" : "NORMAL", message: String(this.data.note || "").trim()
    };
    let intent;
    try { intent = submission.begin("VERIFICATION", identity); }
    catch (error) { return this.setData({ locked: true, message: error.message, error: true }); }
    this.setData({ busy: true, message: "正在原子写入核销、照片凭证、额度和设备信号…", error: false });
    let result = null;
    try {
      result = await callFace("createVerificationApplication", {
        ...identity, faceRequestId: this.data.faceRequestId, faceEvidenceToken: this.data.faceEvidenceToken, clientRequestId: intent.clientRequestId
      });
      if (String(result.recordStatus || "") !== "APPROVED" || !result.verificationId || !result.verificationCode || !result.deviceSignal) {
        throw new Error("服务端未返回完整的已完成核销与设备信号，禁止显示成功");
      }
      if (Number(result.unitCount) !== unitCount || Number(result.deviceSignal.unitCount) !== unitCount) {
        throw new Error("数据库或设备信号返回的核销次数与本次选择不一致，禁止显示成功");
      }
      const confirmedIntent = submission.confirm("VERIFICATION", result.verificationId);
      this.setData({ locked: false, message: `核销单 ${result.verificationCode} 已完成，不会重复扣次。`, error: false, note: "" });
      this.resetBusinessSelection();
      this.setData({ customer: null });
      this.openSubmittedOrder(result, confirmedIntent);
    } catch (error) {
      submission.markUncertain("VERIFICATION");
      await this.recoverAfterError(error, Boolean(result));
    } finally { this.setData({ busy: false }); this.syncReady(); }
  },
  async recoverAfterError(error, hadResult) {
    if (!error.submissionUncertain && !hadResult) {
      try {
        const recovered = await submission.recover("VERIFICATION");
        if (recovered.found && recovered.complete) return this.showRecovered(recovered);
        submission.clear("VERIFICATION");
        if (["FACE_PHOTO_EVIDENCE_REQUIRED", "FACE_PHOTO_EVIDENCE_INVALID"].includes(error.code)) this.resetFace();
        return this.setData({ locked: false, message: error.message || "核销未写入，可修正后重试", error: true });
      } catch (_) { /* keep lock */ }
    }
    this.setData({ locked: true, message: "核销响应中断，扣次可能已完成。为防止第二张单，已锁定再次提交。", error: true });
    await this.recoverPending();
  },
  showRecovered(result) {
    const confirmedIntent = submission.confirm("VERIFICATION", result.verificationId);
    this.setData({ locked: false, message: `已找到上次核销 ${result.verificationCode}，未重复扣次。`, error: false });
    this.openSubmittedOrder(result, confirmedIntent);
    this.syncReady();
  },
  openSubmittedOrder(result, intent) {
    const url = orderUrl(this.data.experience || String(result.verificationType || "").toUpperCase() === "EXPERIENCE", result, intent);
    const experience = this.data.experience || String(result.verificationType || "").toUpperCase() === "EXPERIENCE";
    const hint = submittedOrderHint(this.data.session, experience);
    if (!url) {
      this.setData({ message: `核销已写入，但服务端没有返回完整工单定位信息；${hint}，禁止重复提交。`, error: true });
      return;
    }
    wx.redirectTo({
      url,
      fail: () => {
        this.setData({ locked: true, message: `${result.verificationCode} 已写入，但工单详情打开失败；原提交锁仍保留，${hint}，禁止重复提交。`, error: true });
        wx.showModal({ title: "核销已完成", content: `${result.verificationCode}\n原提交锁仍保留，${hint}详情`, showCancel: false });
      }
    });
  },
  async recoverPending() {
    if (this.data.recovering || !submission.read("VERIFICATION")) return;
    this.setData({ recovering: true, locked: true, message: "正在从数据库核对原核销、照片、额度审计和设备信号…", error: false });
    try {
      const result = await submission.recover("VERIFICATION");
      if (result.found && result.complete) return this.showRecovered(result);
      if (result.found) return this.setData({ message: "核销主记录已写入，但设备信号或体验额度审计不完整。已锁定，请联系管理员。", error: true });
      this.setData({ message: "数据库暂未找到结果，原请求可能仍在执行。请稍后再检查，绝对不要重复提交。", error: true });
    } catch (error) { this.setData({ message: `${error.message || '暂时无法检查'}；已继续锁定重复核销。`, error: true }); }
    finally { this.setData({ recovering: false }); }
  }
});

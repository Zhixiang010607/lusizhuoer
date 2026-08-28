const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore, setSelectedStore } = require("../../services/session");
const submission = require("../../services/submission");
const {
  BleVerificationSession,
  readProgress: readBleProgress,
  saveProgress: saveBleProgress,
  clearProgress: clearBleProgress,
  retryFinalization,
  errorFeedback
} = require("../../services/ble-verification");

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
    experience: false, customer: null, teachers: [], teacherLabels: [], teacherIndex: -1, selectedTeacher: null, teacherOptionsReady: false, teacherReady: false,
    products: [], productLabels: [], productIndex: -1, selectedProduct: null, unitCount: "", unitCountMax: 0, unitCountValid: false, note: "", captureReady: false, faceVerified: false,
    faceRequestId: "", faceEvidenceToken: "", faceMessage: "", faceError: false, loadingOptions: false, verifying: false,
    busy: false, locked: false, recovering: false, ready: false, message: "", error: false,
    qualification: null, qualificationActive: false, qualificationSeconds: 0,
    bleWindowVisible: false, bleRunning: false, bleAuthorizationSent: false,
    blePermanentlyClosed: false, bleStage: "", bleStatusMessage: "",
    bleErrorTitle: "", bleErrorCode: "", bleErrorAdvice: ""
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
    const bleProgress = readBleProgress();
    if (bleProgress?.deviceResult && Number(bleProgress.deviceResult.status) === 2) {
      this.setData({ locked: true, blePermanentlyClosed: true, message: "设备已进入工作状态，正在恢复核销工单；禁止再次扫码。" });
      this.recoverPending();
    } else if (submission.read("VERIFICATION")) {
      this.setData({ locked: true, message: "检测到上一次核销尚未确认，已禁止再次扣减。" });
      this.recoverPending();
    }
  },
  onUnload() {
    this._storeRequestEpoch = (this._storeRequestEpoch || 0) + 1;
    this._teacherRequestEpoch = (this._teacherRequestEpoch || 0) + 1;
    this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
    this._faceRequestEpoch = (this._faceRequestEpoch || 0) + 1;
    if (this._qualificationTimer) clearInterval(this._qualificationTimer);
    if (this._bleSession && !this.data.bleAuthorizationSent) this._bleSession.cancel();
  },
  preventTouchMove() {},
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
    if (this.data.busy || this.data.locked || this.data.qualificationActive) return;
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
      teachers: [], teacherLabels: [], teacherIndex: -1, selectedTeacher: null, teacherOptionsReady: false, teacherReady: false,
      products: [], productLabels: [], productIndex: -1, selectedProduct: null, unitCount: "", unitCountMax: 0, unitCountValid: false,
      note: "", captureReady: false, faceVerified: false, faceRequestId: "", faceEvidenceToken: "",
      faceMessage: "", faceError: false, loadingOptions: false, verifying: false, ready: false,
      message: `已选择 ${store.name}，请确认客户`, error: false
    });
    this.loadTeachers();
  },
  customerChanged() {
    if (this.data.qualificationActive) return;
    this.setData({ customer: null, message: "", error: false });
    this.resetBusinessSelection({ resetTeacher: this.data.session.role === "store", clearNote: true });
  },
  async customerConfirmed(event) {
    if (this.data.qualificationActive) return;
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
      const activeTeachers = (result.teachers || []).map(teacher).filter((item) => item.teacherId);
      const values = this.data.session.role === "store"
        ? [{ teacherId: "", teacherCode: "", teacherName: "不指定业务老师" }, ...activeTeachers]
        : activeTeachers;
      const mineIndex = this.data.session.role === "teacher"
        ? values.findIndex((item) => item.teacherId === String(this.data.session.teacherId || ""))
        : 0;
      const mine = mineIndex >= 0 ? values[mineIndex] : null;
      this.setData({
        teachers: values,
        teacherLabels: values.map((item) => item.teacherId ? `${item.teacherName} · ${item.teacherCode}` : item.teacherName),
        selectedTeacher: mine,
        teacherIndex: mineIndex,
        teacherOptionsReady: true
      });
      if (this.data.session.role === "teacher" && !mine) {
        this.setData({ message: "当前老师不在该门店的可办理老师名单中，已禁止核销", error: true });
      }
      if (this.data.customer && this.data.experience) await this.loadProducts();
      this.syncReady();
    } catch (error) {
      if (requestEpoch === this._teacherRequestEpoch && String(this.data.store.id || "") === storeId) {
        const storeBlank = this.data.session.role === "store"
          ? [{ teacherId: "", teacherCode: "", teacherName: "不指定业务老师" }]
          : [];
        this.setData({
          teachers: storeBlank,
          teacherLabels: storeBlank.map((item) => item.teacherName),
          teacherIndex: storeBlank.length ? 0 : -1,
          selectedTeacher: storeBlank[0] || null,
          teacherOptionsReady: true,
          message: error.message || (this.data.session.role === "teacher" ? "当前老师信息读取失败，已禁止核销" : "老师列表读取失败；仍可不指定老师办理"),
          error: true
        });
        this.syncReady();
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
    if (this.data.qualificationActive) return;
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
    if (this.data.qualificationActive) return;
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
    if (this.data.qualificationActive) return;
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
  inputNote(event) {
    if (!this.data.qualificationActive) this.setData({ note: event.detail.value });
  },
  captureChanged(event) {
    if (this.data.qualificationActive) return;
    this.setData({ captureReady: event.detail.ready === true });
    this.resetFace(false);
  },
  resetBusinessSelection({ resetTeacher = false, clearNote = false } = {}) {
    this._productRequestEpoch = (this._productRequestEpoch || 0) + 1;
    this.setData({
      products: [], productLabels: [], productIndex: -1, selectedProduct: null, unitCount: "", unitCountMax: 0, unitCountValid: false,
      loadingOptions: false, ready: false,
      ...(clearNote ? { note: "" } : {}),
      ...(resetTeacher ? (() => {
        const blankIndex = this.data.teachers.findIndex((item) => !item.teacherId);
        return { teacherIndex: blankIndex, selectedTeacher: blankIndex >= 0 ? this.data.teachers[blankIndex] : null };
      })() : {})
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
    if (!capture || !this.data.customer || !this.data.selectedProduct || !this.data.teacherReady
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
    const teacherReady = this.data.session.role === "store"
      ? this.data.teacherOptionsReady
      : Boolean(this.data.selectedTeacher?.teacherId);
    this.setData({
      unitCountValid: countReady,
      teacherReady,
      ready: Boolean(this.data.store.id && this.data.customer && this.data.selectedProduct && teacherReady && countReady
        && this.data.faceVerified && this.data.faceRequestId && this.data.faceEvidenceToken
        && !this.data.locked && !this.data.qualificationActive)
    });
  },
  async submit() {
    if (this.data.busy || this.data.qualificationActive || !this.data.ready) return;
    const unitCount = Number(this.data.unitCount);
    if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > Number(this.data.unitCountMax || 0)) {
      return this.setData({ message: `核销次数必须由办理人员填写，并且是 1 至 ${this.data.unitCountMax || 0} 的整数`, error: true });
    }
    const identity = {
      storeId: this.data.store.id, customerCode: this.data.customer.customerCode, productId: this.data.selectedProduct.productId,
      unitCount, teacherId: String(this.data.selectedTeacher?.teacherId || ""), verificationType: this.data.experience ? "EXPERIENCE" : "NORMAL", message: String(this.data.note || "").trim()
    };
    let intent;
    try { intent = submission.begin("VERIFICATION", identity); }
    catch (error) { return this.setData({ locked: true, message: error.message, error: true }); }
    this.setData({ busy: true, message: "正在准备设备核销，本次尚未扣次。", error: false });
    try {
      const qualification = await callFace("createVerificationBleQualification", {
        ...identity, faceRequestId: this.data.faceRequestId, faceEvidenceToken: this.data.faceEvidenceToken, clientRequestId: intent.clientRequestId
      });
      if (!qualification || typeof qualification !== "object") {
        throw Object.assign(new Error("设备资格返回为空，本次没有扣次。"), { code: "BLE_QUALIFICATION_INCOMPLETE" });
      }
      if (qualification.complete && qualification.verificationId) {
        return this.showRecovered(qualification);
      }
      if (!qualification.qualificationToken || !qualification.expiresAt || Number(qualification.unitCount) !== unitCount) {
        throw Object.assign(new Error("服务端没有返回完整的 BLE 核销资格，本次没有扣次。"), { code: "BLE_QUALIFICATION_INCOMPLETE" });
      }
      saveBleProgress({
        state: "QUALIFIED",
        irreversible: false,
        clientRequestId: intent.clientRequestId,
        qualificationToken: qualification.qualificationToken,
        qualificationExpiresAt: qualification.expiresAt,
        qualification
      });
      this.activateQualification(qualification, true);
    } catch (error) {
      if (error.submissionUncertain) {
        submission.markUncertain("VERIFICATION");
        this.setData({ locked: true, message: "设备资格响应中断，正在核对原请求；请勿重新拍照提交。", error: true });
        await this.recoverPending();
      } else {
        submission.clear("VERIFICATION");
        if (["FACE_PHOTO_EVIDENCE_REQUIRED", "FACE_PHOTO_EVIDENCE_INVALID"].includes(error.code)) this.resetFace();
        const feedback = errorFeedback(error);
        this.setData({ locked: false, message: feedback.message, error: true });
      }
    } finally { this.setData({ busy: false }); this.syncReady(); }
  },
  activateQualification(qualification, openWindow = false) {
    const expiresAt = new Date(qualification.expiresAt || 0).getTime();
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    if (!seconds) return this.expireQualification();
    if (this._qualificationTimer) clearInterval(this._qualificationTimer);
    const progress = readBleProgress();
    const authorizationSent = Boolean(progress?.authorizationToken
      && String(progress.qualificationToken || "") === String(qualification.qualificationToken || ""));
    this.setData({
      qualification,
      qualificationActive: true,
      qualificationSeconds: seconds,
      bleWindowVisible: openWindow,
      bleAuthorizationSent: authorizationSent,
      blePermanentlyClosed: false,
      bleErrorTitle: "", bleErrorCode: "", bleErrorAdvice: "",
      bleStatusMessage: authorizationSent
        ? "授权已发送，请重新连接原设备核对状态。"
        : "90 秒内扫码连接；设备启动前不扣次。",
      message: "人脸已通过，请在 90 秒内扫码。", error: false,
      ready: false
    });
    this._qualificationTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      this.setData({ qualificationSeconds: remaining });
      if (!remaining) this.expireQualification();
    }, 500);
  },
  expireQualification() {
    if (this._qualificationTimer) clearInterval(this._qualificationTimer);
    this._qualificationTimer = null;
    if (this.data.bleAuthorizationSent) {
      this.setData({ qualificationActive: false, qualificationSeconds: 0, bleWindowVisible: false, locked: true, message: "扫码已超时，正在核对原设备状态，请勿重复办理。", error: true });
      return;
    }
    if (this._bleSession) this._bleSession.cancel();
    this._bleSession = null;
    try { clearBleProgress(); } catch (_) { /* keep visible server result */ }
    try { submission.clear("VERIFICATION"); } catch (_) { /* keep page safe */ }
    this.setData({
      qualification: null, qualificationActive: false, qualificationSeconds: 0,
      bleWindowVisible: false, bleRunning: false, bleAuthorizationSent: false,
      message: "扫码已超时，本次没有扣次，请重新拍照验证。", error: true
    });
    this.resetFace();
  },
  openBleWindow() {
    if (this.data.blePermanentlyClosed) return;
    if (!this.data.qualificationActive || this.data.qualificationSeconds <= 0) return this.expireQualification();
    this.setData({ bleWindowVisible: true, bleErrorTitle: "", bleErrorCode: "", bleErrorAdvice: "" });
  },
  closeBleWindow() {
    if (this.data.blePermanentlyClosed) return;
    if (this.data.bleRunning) return;
    this.setData({ bleWindowVisible: false });
    if (this._bleSession) this._bleSession.cancel();
  },
  async startBleVerification() {
    if (this.data.bleRunning || this.data.blePermanentlyClosed) return;
    if (!this.data.qualificationActive || this.data.qualificationSeconds <= 0) return this.expireQualification();
    const intent = submission.read("VERIFICATION");
    if (!intent?.clientRequestId) {
      return this.setData({ locked: true, bleWindowVisible: false, message: "防重复提交编号丢失，已禁止设备授权；请联系管理员。", error: true });
    }
    this.setData({
      bleWindowVisible: true, bleRunning: true, bleStage: "QR_SCANNING", bleStatusMessage: "准备扫描设备二维码",
      bleErrorTitle: "", bleErrorCode: "", bleErrorAdvice: ""
    });
    const session = new BleVerificationSession({
      qualification: this.data.qualification,
      clientRequestId: intent.clientRequestId,
      onState: (state) => this.setData({ bleStage: state.stage || "", bleStatusMessage: state.message || "" }),
      onIrreversible: (state) => {
        if (state?.authorizationSent) this.setData({ bleAuthorizationSent: true, bleStatusMessage: "授权已发往设备，正在确认是否进入工作状态；请勿重新扫码。" });
        if (state?.deviceResult && Number(state.deviceResult.status) === 2) {
          this.setData({ blePermanentlyClosed: true, bleWindowVisible: false, locked: true, message: "设备已进入工作状态，二维码窗口已永久关闭，正在生成核销工单。", error: false });
        }
      }
    });
    this._bleSession = session;
    try {
      const result = await session.run();
      const confirmedIntent = submission.confirm("VERIFICATION", result.verificationId);
      try { clearBleProgress(); } catch (_) { /* final record is already authoritative */ }
      if (this._qualificationTimer) clearInterval(this._qualificationTimer);
      this.setData({
        qualificationActive: false, bleRunning: false, blePermanentlyClosed: true,
        bleWindowVisible: false, locked: false, message: `设备已启动，核销单 ${result.verificationCode} 已完成。`, error: false
      });
      this.openSubmittedOrder(result, confirmedIntent);
    } catch (error) {
      const progress = readBleProgress();
      if (progress?.deviceResult && Number(progress.deviceResult.status) === 2) {
        this.setData({ blePermanentlyClosed: true, bleWindowVisible: false, locked: true, message: "设备已启动但工单响应中断，正在从数据库恢复；禁止重复扫码。", error: true });
        await this.recoverPending();
      } else {
        const feedback = errorFeedback(error);
        const authorizationSent = Boolean(progress?.authorizationToken
          && String(progress.qualificationToken || "") === String(this.data.qualification?.qualificationToken || ""));
        this.setData({
          bleRunning: false,
          bleAuthorizationSent: authorizationSent,
          bleErrorTitle: feedback.title,
          bleErrorCode: feedback.code,
          bleErrorAdvice: feedback.advice,
          bleStatusMessage: feedback.message,
          message: feedback.message,
          error: !["BLE_QR_CANCELLED", "BLE_WINDOW_CLOSED"].includes(feedback.code)
        });
        if (this.data.qualificationSeconds <= 0) this.expireQualification();
      }
    } finally {
      if (this._bleSession === session) this._bleSession = null;
      if (!this.data.blePermanentlyClosed) this.setData({ bleRunning: false });
    }
  },
  showRecovered(result) {
    const confirmedIntent = submission.confirm("VERIFICATION", result.verificationId);
    try { clearBleProgress(); } catch (_) { /* order acknowledgement keeps idempotency */ }
    if (this._qualificationTimer) clearInterval(this._qualificationTimer);
    this.setData({ locked: false, qualificationActive: false, blePermanentlyClosed: true, bleWindowVisible: false, message: `已找到上次核销 ${result.verificationCode}，未重复扣次。`, error: false });
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
    this.setData({ recovering: true, message: "正在核对 90 秒资格、设备状态和原核销工单…", error: false });
    try {
      const progress = readBleProgress();
      if (progress?.deviceResult && Number(progress.deviceResult.status) === 2) {
        this.setData({ locked: true, blePermanentlyClosed: true, bleWindowVisible: false });
        const finalized = await retryFinalization(progress);
        if (finalized?.verificationId) return this.showRecovered(finalized);
      }
      const intent = submission.read("VERIFICATION");
      const qualification = await callFace("recoverVerificationBleQualification", { clientRequestId: intent.clientRequestId });
      if (qualification?.found && qualification.complete) return this.showRecovered(qualification);
      if (qualification?.found && !qualification.expired && qualification.qualificationToken) {
        this.setData({ locked: false });
        this.activateQualification(qualification, false);
        return;
      }
      if (qualification?.found && qualification.expired) {
        try { clearBleProgress(); } catch (_) { /* continue */ }
        submission.clear("VERIFICATION");
        this.setData({ locked: false, qualificationActive: false, message: "上次 90 秒设备资格已过期且没有扣次，请重新拍照验证。", error: true });
        this.resetFace();
        return;
      }
      const result = await submission.recover("VERIFICATION");
      if (result.found && result.complete) return this.showRecovered(result);
      if (result.found) return this.setData({ message: "核销主记录已写入，但设备信号或体验额度审计不完整。已锁定，请联系管理员。", error: true });
      submission.clear("VERIFICATION");
      this.setData({ locked: false, message: "数据库未找到资格或工单，本次没有扣次；请重新办理。", error: true });
    } catch (error) { this.setData({ message: `${error.message || '暂时无法检查'}；已继续锁定重复核销。`, error: true }); }
    finally { this.setData({ recovering: false }); }
  }
});

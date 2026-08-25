const { callFace } = require("../../services/api");
const { requireSession, getSelectedStore } = require("../../services/session");
const submission = require("../../services/submission");

function teacher(value) { return { teacherId: String(value.teacherId || ""), teacherCode: String(value.teacherCode || ""), teacherName: String(value.teacherName || "") }; }
function product(value) {
  return {
    productId: String(value.productId || ""), productCode: String(value.productCode || ""), productName: String(value.productName || ""),
    remainingCount: Number(value.remainingCount || 0), availableCount: Number(value.availableCount || 0)
  };
}

function orderUrl(experience, result) {
  const recordId = String(result.verificationId || "");
  const recordCode = String(result.verificationCode || "");
  if (!recordId || !recordCode) return "";
  const category = experience ? "EXPERIENCE" : "VERIFICATION";
  return `/pages/order-detail/index?type=verification&category=${category}&recordId=${encodeURIComponent(recordId)}&recordCode=${encodeURIComponent(recordCode)}`;
}

Page({
  data: {
    session: {}, store: {}, experience: false, customer: null, teachers: [], teacherLabels: [], teacherIndex: -1, selectedTeacher: null,
    products: [], productLabels: [], productIndex: -1, selectedProduct: null, note: "", captureReady: false, faceVerified: false,
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
    const store = getSelectedStore(session);
    if (!store) return wx.reLaunch({ url: "/pages/home/index" });
    this.setData({ session, store, experience });
    this.loadTeachers();
    if (submission.read("VERIFICATION")) {
      this.setData({ locked: true, message: "检测到上一次核销尚未确认，已禁止再次扣减。" });
      this.recoverPending();
    }
  },
  customerChanged() { this.setData({ customer: null }); this.resetBusinessSelection(); },
  async customerConfirmed(event) {
    this.setData({ customer: event.detail.customer, message: `已确认 ${event.detail.customer.customerName}`, error: false });
    this.resetFace();
    await this.loadProducts();
  },
  async loadTeachers() {
    try {
      const result = await callFace("listActiveTeachers", { storeId: this.data.store.id });
      const values = (result.teachers || []).map(teacher).filter((item) => item.teacherId);
      const mineIndex = this.data.session.role === "teacher"
        ? values.findIndex((item) => item.teacherId === String(this.data.session.teacherId || ""))
        : -1;
      const mine = mineIndex >= 0 ? values[mineIndex] : null;
      this.setData({ teachers: values, teacherLabels: values.map((item) => `${item.teacherName} · ${item.teacherCode}`), selectedTeacher: mine, teacherIndex: mineIndex });
      if (this.data.customer && this.data.experience) await this.loadProducts();
      this.syncReady();
    } catch (error) { this.setData({ message: error.message || "老师列表读取失败", error: true }); }
  },
  async loadProducts() {
    if (!this.data.customer || (this.data.experience && !this.data.selectedTeacher)) return;
    this.setData({ loadingOptions: true, products: [], productLabels: [], selectedProduct: null, productIndex: -1 });
    this.resetFace();
    try {
      const result = this.data.experience
        ? await callFace("getTeacherExperienceEntitlements", { storeId: this.data.store.id, teacherId: this.data.selectedTeacher.teacherId })
        : await callFace("getCustomerProductBalances", { storeId: this.data.store.id, customerCode: this.data.customer.customerCode });
      const source = this.data.experience ? (result.entitlements || []) : (result.balances || []);
      const values = source.map(product).filter((item) => item.productId && (this.data.experience ? item.availableCount > 0 : item.remainingCount > 0));
      this.setData({
        products: values,
        productLabels: values.map((item) => `${item.productName}（${this.data.experience ? '老师可用' : '客户剩余'} ${this.data.experience ? item.availableCount : item.remainingCount} 次）`)
      });
    } catch (error) { this.setData({ message: error.message || "可核销项目读取失败", error: true }); }
    finally { this.setData({ loadingOptions: false }); this.syncReady(); }
  },
  selectTeacher(event) {
    const index = Number(event.detail.value);
    this.setData({ teacherIndex: index, selectedTeacher: this.data.teachers[index] || null });
    this.resetFace();
    if (this.data.experience) this.loadProducts(); else this.syncReady();
  },
  selectProduct(event) { const index = Number(event.detail.value); this.setData({ productIndex: index, selectedProduct: this.data.products[index] || null }); this.resetFace(); this.syncReady(); },
  inputNote(event) { this.setData({ note: event.detail.value }); },
  captureChanged(event) { this.setData({ captureReady: event.detail.ready === true }); this.resetFace(false); },
  resetBusinessSelection() { this.setData({ products: [], productLabels: [], productIndex: -1, selectedProduct: null }); this.resetFace(); },
  resetFace(resetCamera = true) {
    if (resetCamera) {
      const camera = this.selectComponent("#verificationCamera");
      if (camera) camera.reset();
    }
    this.setData({ faceVerified: false, faceRequestId: "", faceEvidenceToken: "", faceMessage: "", faceError: false });
    this.syncReady();
  },
  async verifyFace() {
    if (this.data.verifying) return;
    const capture = this.selectComponent("#verificationCamera").getCapture();
    if (!capture || !this.data.customer) return;
    this.setData({ verifying: true, faceVerified: false, faceMessage: "正在由服务端完成客户 1:1 人脸与活体验证…", faceError: false });
    try {
      const result = await callFace("verifyCustomerFace", {
        storeId: this.data.store.id, customerCode: this.data.customer.customerCode, imageBase64: capture.imageBase64,
        thumbnailBase64: capture.thumbnailBase64, imageWidth: capture.imageWidth, imageHeight: capture.imageHeight
      });
      const token = String(result.faceEvidenceToken || "");
      const requestId = String(result.requestId || "");
      if (!result.matched || !requestId || !/^[0-9a-f]{48}$/.test(token)) throw new Error("客户人脸验证或现场照片凭证不完整，禁止核销");
      this.setData({ faceVerified: true, faceRequestId: requestId, faceEvidenceToken: token, faceMessage: `客户 1:1 人脸验证通过（${Number(result.score || 0)} 分）`, faceError: false });
    } catch (error) {
      this.setData({ faceVerified: false, faceRequestId: "", faceEvidenceToken: "", faceMessage: error.message || "人脸验证未通过", faceError: true });
    } finally { this.setData({ verifying: false }); this.syncReady(); }
  },
  syncReady() {
    this.setData({ ready: Boolean(this.data.customer && this.data.selectedProduct && this.data.selectedTeacher && this.data.faceVerified && this.data.faceRequestId && this.data.faceEvidenceToken && !this.data.locked) });
  },
  async submit() {
    if (this.data.busy || !this.data.ready) return;
    const identity = {
      storeId: this.data.store.id, customerCode: this.data.customer.customerCode, productId: this.data.selectedProduct.productId,
      teacherId: this.data.selectedTeacher.teacherId, verificationType: this.data.experience ? "EXPERIENCE" : "NORMAL", message: String(this.data.note || "").trim()
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
        throw new Error("服务端未返回完整的已审核核销与设备信号，禁止显示成功");
      }
      submission.clear("VERIFICATION");
      this.setData({ locked: false, message: `核销单 ${result.verificationCode} 已完成，不会重复扣次。`, error: false, note: "" });
      this.resetBusinessSelection();
      this.setData({ customer: null });
      this.openSubmittedOrder(result);
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
    this.setData({ locked: false, message: `已找到上次核销 ${result.verificationCode}，未重复扣次。`, error: false });
    this.openSubmittedOrder(result);
    this.syncReady();
  },
  openSubmittedOrder(result) {
    const url = orderUrl(this.data.experience || String(result.verificationType || "").toUpperCase() === "EXPERIENCE", result);
    if (!url) {
      this.setData({ message: "核销已写入，但服务端没有返回完整工单定位信息；请从核销查询进入，禁止重复提交。", error: true });
      return;
    }
    wx.redirectTo({
      url,
      fail: () => {
        this.setData({ message: `${result.verificationCode} 已写入，但工单详情打开失败；请从核销查询进入，禁止重复提交。`, error: true });
        wx.showModal({ title: "核销已完成", content: `${result.verificationCode}\n请从核销查询进入详情`, showCancel: false });
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

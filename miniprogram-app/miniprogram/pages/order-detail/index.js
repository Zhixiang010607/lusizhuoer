const { callFace, callPhoto, callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");
const submission = require("../../services/submission");

const PHOTO_LABELS = Object.freeze(["客户留存照", "本次核销照", "补充照片 1", "补充照片 2", "补充照片 3"]);

function value(row, snake, camel) { return row?.[snake] ?? row?.[camel] ?? ""; }
function clean(input) { return String(input ?? "").trim(); }
function optionalNumber(input) {
  if (input === null || input === undefined || input === "") return "—";
  const number = Number(input);
  return Number.isFinite(number) ? `${number} 次` : "—";
}

function normalizeStaffOrder(row, baseType) {
  const record = query.normalizeRecord(row, baseType);
  const originalStatus = clean(value(row, "original_status", "originalStatus") || record.recordStatus);
  const originalType = clean(value(row, "original_type", "originalType") || record.originalType);
  const address = [
    value(row, "store_province", "storeProvince"), value(row, "store_city", "storeCity"),
    value(row, "store_district", "storeDistrict"), value(row, "store_address_detail", "storeAddressDetail")
  ].map(clean).filter(Boolean).join("");
  return {
    ...record,
    originalType,
    typeLabel: query.typeLabel(baseType, originalType),
    recordStatus: originalStatus,
    statusLabel: query.statusLabel(originalStatus),
    reviewedAt: query.displayDateTime(value(row, "original_reviewed_at", "originalReviewedAt")),
    storeAddress: address || "未填写",
    message: clean(value(row, "initial_store_note", "initialStoreNote")),
    reviewNote: clean(value(row, "initial_review_note", "initialReviewNote")),
    supplementNote: clean(value(row, "supplement_note", "supplementNote")),
    balanceBeforeLabel: optionalNumber(value(row, "balance_before_count", "balanceBeforeCount")),
    balanceAfterLabel: optionalNumber(value(row, "balance_after_count", "balanceAfterCount")),
    voidStatus: clean(value(row, "void_request_status", "voidRequestStatus")),
    voidNote: clean(value(row, "void_request_note", "voidRequestNote")),
    voidReviewNote: clean(value(row, "void_review_note", "voidReviewNote")),
    voidSubmittedAt: query.displayDateTime(value(row, "void_requested_at", "voidRequestedAt")),
    voidReviewedAt: query.displayDateTime(value(row, "void_reviewed_at", "voidReviewedAt"))
  };
}

function normalizeTeacherOrder(row, baseType) {
  const record = query.normalizeRecord(row, baseType);
  const address = [row.storeProvince, row.storeCity, row.storeDistrict, row.storeAddressDetail].map(clean).filter(Boolean).join("");
  return {
    ...record,
    reviewedAt: query.displayDateTime(row.reviewedAt),
    storeAddress: address || "未填写",
    message: clean(row.message), reviewNote: clean(row.reviewNote), supplementNote: clean(row.supplementNote),
    balanceBeforeLabel: optionalNumber(row.balanceBeforeCount), balanceAfterLabel: optionalNumber(row.balanceAfterCount),
    voidStatus: clean(row.voidRequestStatus), voidNote: "", voidReviewNote: "", voidSubmittedAt: "—", voidReviewedAt: "—"
  };
}

Page({
  data: {
    session: {}, recordId: "", recordCode: "", submissionClientRequestId: "", baseType: "RECHARGE", category: "RECHARGE", noun: "充值",
    order: null, facts: [], notes: [], photos: [], loading: true, photoLoading: false,
    message: "", error: false
  },

  onLoad(options) {
    const session = requireSession();
    if (!session) return;
    const baseType = String(options.type || "recharge").toUpperCase() === "VERIFICATION" ? "VERIFICATION" : "RECHARGE";
    const category = clean(options.category || baseType).toUpperCase();
    const noun = baseType === "VERIFICATION" ? (category === "EXPERIENCE" ? "体验核销" : "核销") : (category === "REFUND" ? "退费" : "充值");
    this.setData({
      session, baseType, category, noun,
      recordId: decodeURIComponent(options.recordId || ""), recordCode: decodeURIComponent(options.recordCode || ""),
      submissionClientRequestId: decodeURIComponent(options.submissionClientRequestId || "")
    });
    wx.setNavigationBarTitle({ title: `${this.data.noun}工单详情` });
    this.load();
  },

  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  async load() {
    if (!this.data.recordId || this.data.loading === "locked") return;
    this.setData({ loading: "locked", message: "", error: false, photos: [] });
    try {
      let order;
      if (this.data.session.role === "teacher") {
        const result = await callFace("getTeacherWorkspace", { recordType: this.data.category, recordId: this.data.recordId });
        order = normalizeTeacherOrder(result.record, this.data.baseType);
      } else {
        const result = await callStaff("listReviewOrders", {
          recordType: this.data.baseType, recordId: this.data.recordId,
          recordCode: this.data.recordCode, detailRead: true, limit: 1
        });
        order = normalizeStaffOrder((result.orders || [])[0], this.data.baseType);
      }
      if (!order?.id) throw new Error("数据库中未找到该张工单");
      const facts = [
        { label: "门店", value: order.storeName, note: order.storeCode || "—" },
        { label: "客户", value: order.customerName, note: order.customerCode || "—" },
        { label: "项目", value: order.productName, note: order.productCode || "—" },
        { label: "业务老师", value: order.teacherName || "未指定", note: order.teacherCode || "—" }
      ];
      const notes = [
        { label: "提交说明", value: order.message }, { label: "审核说明", value: order.reviewNote },
        { label: "补录说明", value: order.supplementNote }, { label: "作废说明", value: order.voidNote },
        { label: "作废审核说明", value: order.voidReviewNote }
      ].filter((item) => item.value);
      this.setData({ order, facts, notes, loading: false });
      if (this.data.submissionClientRequestId) {
        try {
          const acknowledged = submission.acknowledge(this.data.baseType, this.data.recordId, this.data.submissionClientRequestId);
          if (!acknowledged) this.setData({ message: "工单详情已读取，但原提交确认信息不一致；防重复提交锁仍保留。", error: true });
        } catch (error) {
          this.setData({ message: error.message || "工单详情已读取，但防重复提交锁尚未清除。", error: true });
        }
      }
      if (this.data.baseType === "VERIFICATION") await this.loadPhotos();
    } catch (error) {
      this.setData({ order: null, loading: false, message: error.message || "工单详情读取失败", error: true });
    }
  },

  async loadPhotos() {
    if (this.data.photoLoading || !this.data.order?.id) return;
    this.setData({ photoLoading: true });
    try {
      const result = await callPhoto("getVerificationPhotos", { recordId: this.data.order.id });
      const photos = (result.photos || []).map((photo) => ({
        ...photo, slot: Number(photo.slot), label: PHOTO_LABELS[Number(photo.slot)] || `照片 ${Number(photo.slot) + 1}`,
        sizeLabel: Number(photo.originalBytes || 0) ? `${Math.max(1, Math.round(Number(photo.originalBytes) / 1024))} KB` : "已保存"
      }));
      this.setData({ photos });
    } catch (error) {
      this.setData({ message: error.message || "核销照片读取失败", error: true });
    } finally { this.setData({ photoLoading: false }); }
  },

  async previewPhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    if (!Number.isInteger(slot)) return;
    wx.showLoading({ title: "读取原图", mask: true });
    try {
      const result = await callPhoto("getVerificationPhotoOriginalUrl", { recordId: this.data.order.id, slot });
      if (!/^https:\/\//i.test(clean(result.photoUrl))) throw new Error("服务端未返回有效原图地址");
      wx.previewImage({ current: result.photoUrl, urls: [result.photoUrl] });
    } catch (error) {
      this.setData({ message: error.message || "高清原图读取失败", error: true });
    } finally { wx.hideLoading(); }
  },

  async savePhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    if (!Number.isInteger(slot)) return;
    wx.showLoading({ title: "保存原图", mask: true });
    try {
      const result = await callPhoto("getVerificationPhotoOriginalUrl", { recordId: this.data.order.id, slot });
      const downloaded = await new Promise((resolve, reject) => wx.downloadFile({ url: result.photoUrl, success: resolve, fail: reject }));
      if (downloaded.statusCode !== 200 || !downloaded.tempFilePath) throw new Error("原图下载失败");
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: downloaded.tempFilePath, success: resolve, fail: reject }));
      this.setData({ message: "高清原图已保存到系统相册，未压缩。", error: false });
    } catch (error) {
      this.setData({ message: error.errMsg || error.message || "原图保存失败，请检查相册权限", error: true });
    } finally { wx.hideLoading(); }
  },

  openCustomer() {
    if (this.data.order?.customerCode) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(this.data.order.customerCode)}` });
  },
  openFact(event) {
    if (event.currentTarget.dataset.label === "客户") this.openCustomer();
  }
});

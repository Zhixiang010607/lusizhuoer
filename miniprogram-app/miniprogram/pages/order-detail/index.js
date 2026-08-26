const { callFace, callPhoto, callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");
const submission = require("../../services/submission");
const { saveImageToAlbum } = require("../../services/photo-album");
const {
  renderReceiptCanvas,
  exportReceiptJpegs,
  createPdfBytes: jpegPdf,
  safeFilename
} = require("../../services/order-receipt");

const PHOTO_SLOT_COUNT = 5;
const MAX_EXTRA_PHOTO_BYTES = 3 * 1024 * 1024;
const PHOTO_LABELS = Object.freeze(["客户留存照", "本次核销照", "补充照片 1", "补充照片 2", "补充照片 3"]);

function value(row, snake, camel) { return row?.[snake] ?? row?.[camel] ?? ""; }
function clean(input) { return String(input ?? "").trim(); }
function optionalNumber(input) {
  if (input === null || input === undefined || input === "") return "—";
  const number = Number(input);
  return Number.isFinite(number) ? `${number} 次` : "—";
}
function normalizedInstructions(input) { return clean(input).replace(/\r\n?/g, "\n"); }
function normalizeProductGifts(input) {
  let rows = input;
  if (typeof rows === "string") {
    try { rows = JSON.parse(rows); } catch (_) { rows = []; }
  }
  return (Array.isArray(rows) ? rows : []).map((item, index) => ({
    id: clean(item?.id || index + 1),
    retailProductId: clean(item?.retailProductId ?? item?.retail_product_id ?? item?.productId ?? item?.product_id),
    productCode: clean(item?.productCode ?? item?.product_code_snapshot ?? item?.product_code),
    productName: clean(item?.productName ?? item?.product_name_snapshot ?? item?.product_name),
    unitCount: Number(item?.unitCount ?? item?.unit_count ?? item?.quantity ?? 0),
    displayOrder: Number(item?.displayOrder ?? item?.display_order ?? index + 1)
  })).filter((item) => item.retailProductId && Number.isInteger(item.unitCount) && item.unitCount > 0)
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

function exactOrderKind(baseType, originalType) {
  const family = clean(baseType).toUpperCase() === "VERIFICATION" ? "VERIFICATION" : "RECHARGE";
  const exact = clean(originalType).toUpperCase();
  if (family === "VERIFICATION") {
    return {
      category: exact === "EXPERIENCE" ? "EXPERIENCE" : "VERIFICATION",
      noun: exact === "EXPERIENCE" ? "体验核销" : "核销",
      typeLabel: query.typeLabel(family, exact)
    };
  }
  return {
    category: exact === "REFUND" ? "REFUND" : "RECHARGE",
    noun: exact === "REFUND" ? "退费" : "充值",
    typeLabel: query.typeLabel(family, exact)
  };
}

function routeOrderExpectation(route = {}) {
  const baseType = clean(route.baseType).toUpperCase();
  const requestedCategory = clean(route.category).toUpperCase();
  const recordId = clean(route.recordId);
  const recordCode = clean(route.recordCode).toUpperCase();
  if (!recordId || !recordCode) throw new Error("工单详情链接缺少完整工单编号");
  if (baseType === "RECHARGE") {
    if (["RECHARGE", "NEW"].includes(requestedCategory)) {
      return { baseType, category: "RECHARGE", originalType: "NEW", recordId, recordCode };
    }
    if (requestedCategory === "REFUND") {
      return { baseType, category: "REFUND", originalType: "REFUND", recordId, recordCode };
    }
    if (requestedCategory === "VOID") {
      return { baseType, category: "VOID", originalType: "", recordId, recordCode, requireVoidRequest: true };
    }
    throw new Error("工单详情链接中的充值业务类型无效");
  }
  if (baseType === "VERIFICATION") {
    if (["VERIFICATION", "NORMAL"].includes(requestedCategory)) {
      return { baseType, category: "VERIFICATION", originalType: "NORMAL", recordId, recordCode };
    }
    if (requestedCategory === "EXPERIENCE") {
      return { baseType, category: "EXPERIENCE", originalType: "EXPERIENCE", recordId, recordCode };
    }
    if (requestedCategory === "SUPPLEMENT") {
      return { baseType, category: "SUPPLEMENT", originalType: "SUPPLEMENT", recordId, recordCode };
    }
    throw new Error("工单详情链接中的核销业务类型无效");
  }
  throw new Error("工单详情链接中的业务大类无效");
}

function assertExactRouteOrder(route, order = {}) {
  const expected = routeOrderExpectation(route);
  const serverBaseType = clean(order.serverBaseType).toUpperCase();
  const serverId = clean(order.id);
  const serverCode = clean(order.recordCode).toUpperCase();
  const serverOriginalType = clean(order.originalType).toUpperCase();
  const voidStatus = clean(order.voidStatus).toUpperCase();
  if (serverId !== expected.recordId) throw new Error("数据库返回的工单与详情链接编号不一致");
  if (serverCode !== expected.recordCode) throw new Error("数据库返回的完整工单号与详情链接不一致");
  if (serverBaseType !== expected.baseType) throw new Error("数据库返回的工单业务大类与详情链接不一致");
  if (expected.requireVoidRequest) {
    if (!voidStatus || voidStatus === "NONE") throw new Error("数据库返回的工单不是详情链接指定的作废业务");
  } else if (serverOriginalType !== expected.originalType) {
    throw new Error("数据库返回的工单业务类型与详情链接不一致");
  }
  return expected;
}

function detailStatusLabel(baseType, originalType, status) {
  const family = clean(baseType).toUpperCase();
  const exact = clean(originalType).toUpperCase();
  const state = clean(status).toUpperCase();
  if (family === "VERIFICATION" && ["NORMAL", "EXPERIENCE"].includes(exact) && state === "APPROVED") return "已完成";
  return query.statusLabel(state);
}

function receiptDocumentData(order, baseType, template) {
  const source = order || {};
  const recharge = clean(baseType).toUpperCase() === "RECHARGE";
  const refund = recharge && clean(source.originalType).toUpperCase() === "REFUND";
  const supplement = !recharge && clean(source.originalType).toUpperCase() === "SUPPLEMENT";
  const reviewVisible = recharge || supplement;
  const businessName = refund ? "退费" : recharge ? "充值" : "核销";
  const customerIdentity = [clean(source.customerName), clean(source.customerCode)].filter(Boolean).join(" · ") || "—";
  const facts = [
    { label: "客户", value: customerIdentity, singleLine: true, span: 2 },
    { label: "门店", value: source.storeName },
    { label: "项目", value: source.productName },
    { label: "业务老师", value: source.teacherName || "未指定" }
  ];
  if (!recharge) facts.push({ label: "提交时间", value: source.submittedAt || "—" });
  const details = recharge ? [
    { label: refund ? "退费次数" : "充值次数", value: `${Number(source.unitCount || 0)} 次` },
    { label: "提交时间", value: source.submittedAt || "—" },
    { label: "审核时间", value: source.reviewedAt || "—" }
  ] : [];
  if (recharge) {
    normalizeProductGifts(source.productGifts).forEach((gift, index) => {
      details.push({ label: `赠予产品 ${index + 1}`, value: `${gift.productName}${gift.productCode ? ` · ${gift.productCode}` : ""} × ${gift.unitCount} 件` });
    });
  }
  const messages = [
    source.message ? { label: "提交说明", value: source.message, time: source.submittedAt || "" } : null,
    reviewVisible && source.reviewNote ? { label: "审核说明", value: source.reviewNote, time: source.reviewedAt || "" } : null,
    source.supplementNote ? { label: "补录说明", value: source.supplementNote } : null,
    source.voidNote ? { label: "作废说明", value: source.voidNote, time: source.voidSubmittedAt || "" } : null,
    source.voidReviewNote ? { label: "作废审核说明", value: source.voidReviewNote, time: source.voidReviewedAt || "" } : null
  ].filter(Boolean);
  return {
    filename: `${source.customerName || "客户"}+${source.productName || "项目"}+${businessName}`,
    kind: source.typeLabel || businessName,
    title: `${refund ? "退费单" : recharge ? "充值单" : "核销单"} ${source.recordCode || "—"}`,
    subtitle: recharge
      ? `门店详细地址：${source.storeAddress || "未填写"}`
      : `门店详细地址：${source.storeAddress || "未填写"} · 提交时间：${source.submittedAt || "—"}${supplement ? ` · 审核时间：${source.reviewedAt || "—"}` : ""}`,
    facts,
    customerFacing: true,
    compactVerification: !recharge,
    detailTitle: refund ? "退费信息" : recharge ? "充值信息" : "核销信息",
    detailSubtitle: refund ? "退费次数与办理时间" : recharge ? "充值次数与办理时间" : "该工单数据库中保存的完整业务内容",
    details,
    messages,
    productTemplate: {
      productName: template.productName || source.productName || "产品",
      productType: template.productType || "未分类",
      instructions: recharge ? template.rechargeInstructions : template.verificationInstructions,
      logoRequired: Boolean(template.logo)
    }
  };
}

function receiptPhotoItems(photos) {
  const bySlot = new Map((Array.isArray(photos) ? photos : []).map((photo) => [Number(photo.slot), photo]));
  return Array.from({ length: PHOTO_SLOT_COUNT }, (_, slot) => {
    const photo = bySlot.get(slot) || {};
    const required = photo.declared === true;
    return {
      slot,
      label: photo.label || PHOTO_LABELS[slot],
      required,
      source: photo.exportSource || "",
      placeholder: required ? "照片读取失败" : "尚未上传",
      meta: required ? "高清原图" : "空照片位"
    };
  });
}

function labelsForManifest(result, noun = "核销") {
  const labels = [...PHOTO_LABELS];
  if (clean(result?.faceSubjectType).toUpperCase() === "TEACHER") labels[0] = "老师留存照";
  labels[1] = `${clean(noun) || "核销"}现场照`;
  return labels;
}

function buildPhotoSlots(state = "empty", labels = PHOTO_LABELS) {
  return Array.from({ length: PHOTO_SLOT_COUNT }, (_, slot) => ({
    slot,
    label: labels[slot] || `照片 ${slot + 1}`,
    state,
    declared: false,
    thumbnailState: state === "loading" ? "loading" : "empty",
    thumbnailUrl: "",
    retrying: false
  }));
}

function normalizePhotoManifest(result, labels = PHOTO_LABELS) {
  if (!result || !Array.isArray(result.photos)) throw new Error("照片清单格式无效");
  if (result.maxPhotos !== undefined && Number(result.maxPhotos) !== PHOTO_SLOT_COUNT) {
    throw new Error("照片清单位置数量与当前页面不一致");
  }
  const rows = new Map();
  result.photos.forEach((photo) => {
    const slot = Number(photo?.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= PHOTO_SLOT_COUNT || rows.has(slot)) {
      throw new Error("照片清单包含无效或重复的位置");
    }
    rows.set(slot, photo);
  });
  const slots = buildPhotoSlots("empty", labels).map((slot) => {
    const photo = rows.get(slot.slot);
    if (!photo) return slot;
    const thumbnailUrl = clean(photo.thumbnailUrl);
    return {
      ...slot,
      ...photo,
      slot: slot.slot,
      label: slot.label,
      state: "ready",
      declared: true,
      thumbnailUrl,
      thumbnailState: thumbnailUrl ? "ready" : "error",
      retrying: false
    };
  });
  return { slots, count: rows.size };
}

function normalizeStaffOrder(row, baseType) {
  const source = row || {};
  const record = query.normalizeRecord(source, baseType);
  const originalStatus = clean(value(source, "original_status", "originalStatus") || record.recordStatus);
  const originalType = clean(value(source, "original_type", "originalType") || record.originalType).toUpperCase();
  const address = [
    value(source, "store_province", "storeProvince"), value(source, "store_city", "storeCity"),
    value(source, "store_district", "storeDistrict"), value(source, "store_address_detail", "storeAddressDetail")
  ].map(clean).filter(Boolean).join("");
  return {
    ...record,
    serverBaseType: clean(value(source, "record_type", "recordType")).toUpperCase(),
    originalType,
    typeLabel: query.typeLabel(baseType, originalType),
    recordStatus: originalStatus,
    statusLabel: detailStatusLabel(baseType, originalType, originalStatus),
    reviewedAt: query.displayDateTime(value(source, "original_reviewed_at", "originalReviewedAt")),
    storeAddress: address || "未填写",
    message: clean(value(source, "initial_store_note", "initialStoreNote")),
    reviewNote: clean(value(source, "initial_review_note", "initialReviewNote")),
    supplementNote: clean(value(source, "supplement_note", "supplementNote")),
    balanceBeforeLabel: optionalNumber(value(source, "balance_before_count", "balanceBeforeCount")),
    balanceAfterLabel: optionalNumber(value(source, "balance_after_count", "balanceAfterCount")),
    voidStatus: clean(value(source, "void_request_status", "voidRequestStatus")),
    voidNote: clean(value(source, "void_request_note", "voidRequestNote")),
    voidReviewNote: clean(value(source, "void_review_note", "voidReviewNote")),
    voidSubmittedAt: query.displayDateTime(value(source, "void_requested_at", "voidRequestedAt")),
    voidReviewedAt: query.displayDateTime(value(source, "void_reviewed_at", "voidReviewedAt")),
    productGifts: normalizeProductGifts(value(source, "product_gifts", "productGifts"))
  };
}

function normalizeTeacherOrder(row, baseType) {
  const source = row || {};
  const record = query.normalizeRecord(source, baseType);
  const address = [source.storeProvince, source.storeCity, source.storeDistrict, source.storeAddressDetail].map(clean).filter(Boolean).join("");
  return {
    ...record,
    serverBaseType: clean(source.recordType).toUpperCase(),
    originalType: clean(record.originalType).toUpperCase(),
    reviewedAt: query.displayDateTime(source.reviewedAt),
    storeAddress: address || "未填写",
    message: clean(source.message), reviewNote: clean(source.reviewNote), supplementNote: clean(source.supplementNote),
    balanceBeforeLabel: optionalNumber(source.balanceBeforeCount), balanceAfterLabel: optionalNumber(source.balanceAfterCount),
    voidStatus: clean(source.voidRequestStatus), voidNote: "", voidReviewNote: "", voidSubmittedAt: "—", voidReviewedAt: "—",
    productGifts: normalizeProductGifts(source.productGifts)
  };
}

function wxCall(invoke) { return new Promise((resolve, reject) => invoke(resolve, reject)); }
function readFile(filePath, encoding) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, ...(encoding ? { encoding } : {}), success: resolve, fail: reject }));
}
function writeFile(filePath, data) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data, success: resolve, fail: reject }));
}
function openPdfDocument(filePath) {
  if (typeof wx.openDocument !== "function") {
    return Promise.reject(new Error("当前微信版本无法打开 PDF，请升级微信后重试"));
  }
  return wxCall((resolve, reject) => wx.openDocument({
    filePath,
    fileType: "pdf",
    showMenu: true,
    success: resolve,
    fail: reject
  }));
}
function imageInfo(src) { return wxCall((resolve, reject) => wx.getImageInfo({ src, success: resolve, fail: reject })); }
function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    const bytes = part instanceof Uint8Array ? part : new Uint8Array(part);
    output.set(bytes, offset);
    offset += bytes.byteLength;
  });
  return output;
}

function jpegDataUrl(input, expectedBytes = 0) {
  const source = clean(input);
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/i.exec(source);
  if (!match) throw new Error("照片服务没有返回有效 JPEG 原图");
  let buffer;
  try { buffer = wx.base64ToArrayBuffer(match[1]); } catch (_) { throw new Error("照片原图数据无法解析"); }
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("照片原图不是有效 JPEG");
  const recorded = Number(expectedBytes || 0);
  if (recorded > 0 && bytes.byteLength !== recorded) throw new Error("照片原图与数据库记录大小不一致");
  return { source, buffer, bytes: bytes.byteLength };
}

function requestId(slot) {
  const random = Math.random().toString(36).slice(2, 14).padEnd(12, "0");
  return `mini-photo-${Date.now().toString(36)}-${Number(slot)}-${random}`.slice(0, 64);
}

async function mapWithConcurrency(items, limit, mapper) {
  const values = Array.isArray(items) ? items : [];
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

Page({
  data: {
    session: {}, recordId: "", recordCode: "", submissionClientRequestId: "", baseType: "RECHARGE", category: "RECHARGE", noun: "充值",
    order: null, facts: [], notes: [], loading: true,
    photos: buildPhotoSlots(), photoCount: 0, photoLoading: false, photoManifestLoaded: false, photoManifestError: "",
    canEdit: false, isSubmitter: false, editableUntil: "", editableUntilLabel: "—", uploading: false, uploadingSlot: -1,
    exporting: false, exportProgress: "", originalBusySlot: -1,
    message: "", error: false
  },

  onLoad(options) {
    const session = requireSession();
    if (!session) return;
    const baseType = String(options.type || "recharge").toUpperCase() === "VERIFICATION" ? "VERIFICATION" : "RECHARGE";
    const category = clean(options.category || baseType).toUpperCase();
    const routeKind = exactOrderKind(baseType, category === "EXPERIENCE" || category === "REFUND" ? category : "");
    this.setData({
      session, baseType, category, noun: routeKind.noun,
      recordId: decodeURIComponent(options.recordId || ""), recordCode: decodeURIComponent(options.recordCode || ""),
      submissionClientRequestId: decodeURIComponent(options.submissionClientRequestId || "")
    });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    this.load();
  },

  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  async load() {
    if (this.data.loading === "locked") return;
    const request = Object.freeze({
      role: clean(this.data.session.role).toLowerCase(),
      baseType: clean(this.data.baseType).toUpperCase(),
      category: clean(this.data.category).toUpperCase(),
      recordId: clean(this.data.recordId),
      recordCode: clean(this.data.recordCode),
      submissionClientRequestId: clean(this.data.submissionClientRequestId)
    });
    const verification = request.baseType === "VERIFICATION";
    this.setData({
      loading: "locked", message: "", error: false,
      ...(verification ? {
        photos: buildPhotoSlots("loading"), photoCount: 0, photoManifestLoaded: false, photoManifestError: "",
        canEdit: false, isSubmitter: false, editableUntil: "", editableUntilLabel: "—"
      } : {})
    });
    try {
      const routeIdentity = routeOrderExpectation(request);
      let order;
      if (request.role === "teacher") {
        const result = await callFace("getTeacherWorkspace", { recordType: request.category, recordId: request.recordId });
        order = normalizeTeacherOrder(result.record, request.baseType);
      } else {
        const result = await callStaff("listReviewOrders", {
          recordType: request.baseType, recordId: request.recordId,
          recordCode: request.recordCode, detailRead: true, limit: 1
        });
        order = normalizeStaffOrder((result.orders || [])[0], request.baseType);
      }
      if (!order?.id) throw new Error("数据库中未找到该张工单");
      assertExactRouteOrder(routeIdentity, order);
      const exactKind = exactOrderKind(request.baseType, order.originalType);
      order.typeLabel = exactKind.typeLabel;
      const facts = [
        { label: "门店", value: order.storeName, note: order.storeCode || "—" },
        { label: "客户", value: order.customerName, note: order.customerCode || "—" },
        { label: "项目", value: order.productName, note: order.productCode || "—" },
        { label: "业务老师", value: order.teacherName || "未指定", note: order.teacherCode || "—" }
      ];
      const notes = [
        { label: "提交说明", value: order.message },
        ...((request.baseType === "RECHARGE" || clean(order.originalType).toUpperCase() === "SUPPLEMENT")
          ? [{ label: "审核说明", value: order.reviewNote }]
          : []),
        { label: "补录说明", value: order.supplementNote }, { label: "作废说明", value: order.voidNote },
        { label: "作废审核说明", value: order.voidReviewNote }
      ].filter((item) => item.value);
      this.setData({ order, facts, notes, category: routeIdentity.category, noun: exactKind.noun, loading: false });
      wx.setNavigationBarTitle({ title: "露思卓儿" });
      if (request.submissionClientRequestId) {
        try {
          const acknowledged = submission.acknowledge(request.baseType, request.recordId, request.submissionClientRequestId);
          if (!acknowledged) this.setData({ message: "工单详情已读取，但原提交确认信息不一致；防重复提交锁仍保留。", error: true });
        } catch (error) {
          this.setData({ message: error.message || "工单详情已读取，但防重复提交锁尚未清除。", error: true });
        }
      }
      if (verification) await this.loadPhotos();
    } catch (error) {
      this.setData({ order: null, loading: false, message: error.message || "工单详情读取失败", error: true });
    }
  },

  applyPhotoManifest(result) {
    const normalized = normalizePhotoManifest(result, labelsForManifest(result, this.data.noun));
    this.setData({
      photos: normalized.slots, photoCount: normalized.count, photoManifestLoaded: true, photoManifestError: "",
      canEdit: result.canEdit === true, isSubmitter: result.isSubmitter === true,
      editableUntil: result.editableUntil || "", editableUntilLabel: query.displayDateTime(result.editableUntil)
    });
    return normalized;
  },

  async loadPhotos() {
    if (this.data.photoLoading || !this.data.order?.id) return false;
    const hadManifest = this.data.photoManifestLoaded;
    this.setData({
      photoLoading: true, photoManifestError: "",
      ...(!hadManifest ? { photos: buildPhotoSlots("loading", labelsForManifest({}, this.data.noun)), photoCount: 0 } : {})
    });
    try {
      const result = await callPhoto("getVerificationPhotos", { recordId: this.data.order.id });
      this.applyPhotoManifest(result);
      return true;
    } catch (error) {
      const message = error.message || "核销照片清单读取失败";
      this.setData({
        photoManifestError: message,
        ...(!hadManifest ? {
          photos: buildPhotoSlots("list-error", labelsForManifest({}, this.data.noun)), photoCount: 0,
          photoManifestLoaded: false, canEdit: false, isSubmitter: false, editableUntil: "", editableUntilLabel: "—"
        } : {}),
        message, error: true
      });
      return false;
    } finally { this.setData({ photoLoading: false }); }
  },

  retryPhotoList() {
    if (this.data.uploading || this.data.exporting) return false;
    return this.loadPhotos();
  },

  updatePhotoSlot(slot, changes) {
    this.setData({ photos: this.data.photos.map((photo) => Number(photo.slot) === Number(slot) ? { ...photo, ...changes } : photo) });
  },

  photoThumbnailError(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    const photo = this.data.photos.find((item) => item.slot === slot);
    if (photo?.declared) this.updatePhotoSlot(slot, { thumbnailState: "error", thumbnailUrl: "", retrying: false });
  },

  async retryThumbnail(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    const photo = this.data.photos.find((item) => item.slot === slot);
    if (!photo?.declared || photo.retrying) return;
    this.updatePhotoSlot(slot, { retrying: true });
    try {
      const result = await callPhoto("getVerificationPhotoThumbnailData", { recordId: this.data.order.id, slot });
      if (Number(result.slot) !== slot) throw new Error("缩略图位置与请求不一致");
      const image = jpegDataUrl(result.imageBase64, result.bytes);
      this.updatePhotoSlot(slot, { thumbnailUrl: image.source, thumbnailState: "ready", retrying: false });
    } catch (error) {
      this.updatePhotoSlot(slot, { thumbnailUrl: "", thumbnailState: "error", retrying: false });
      this.setData({ message: error.message || "该照片缩略图读取失败", error: true });
    }
  },

  async originalPhotoSource(slot) {
    const photo = this.data.photos.find((item) => item.slot === slot);
    if (!photo?.declared) throw new Error("该照片位置尚未上传");
    const result = await callPhoto("getVerificationPhotoOriginalUrl", { recordId: this.data.order.id, slot });
    const source = clean(result.photoUrl);
    if (/^https:\/\//i.test(source)) return { source, buffer: null };
    const image = jpegDataUrl(source, result.originalBytes || photo.originalBytes);
    return { source: image.source, buffer: image.buffer };
  },

  async localOriginalPath(slot, resolved) {
    if (resolved.buffer) {
      const path = `${wx.env.USER_DATA_PATH}/order-photo-${this.data.order.id}-${slot}-${Date.now()}.jpg`;
      await writeFile(path, resolved.buffer);
      return path;
    }
    const downloaded = await wxCall((resolve, reject) => wx.downloadFile({ url: resolved.source, success: resolve, fail: reject }));
    if (downloaded.statusCode !== 200 || !downloaded.tempFilePath) throw new Error("原图下载失败");
    return downloaded.tempFilePath;
  },

  async previewPhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    if (!Number.isInteger(slot) || this.data.originalBusySlot >= 0) return;
    this.setData({ originalBusySlot: slot, message: "", error: false });
    wx.showLoading({ title: "读取原图", mask: true });
    try {
      const resolved = await this.originalPhotoSource(slot);
      const current = resolved.buffer ? await this.localOriginalPath(slot, resolved) : resolved.source;
      await wxCall((resolve, reject) => wx.previewImage({ current, urls: [current], success: resolve, fail: reject }));
    } catch (error) {
      this.setData({ message: error.message || error.errMsg || "原图读取失败", error: true });
    } finally {
      wx.hideLoading();
      this.setData({ originalBusySlot: -1 });
    }
  },

  async savePhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    if (!Number.isInteger(slot) || this.data.originalBusySlot >= 0) return;
    this.setData({ originalBusySlot: slot, message: "", error: false });
    wx.showLoading({ title: "保存原图", mask: true });
    try {
      const resolved = await this.originalPhotoSource(slot);
      const filePath = await this.localOriginalPath(slot, resolved);
      await saveImageToAlbum(filePath);
      this.setData({ message: "原图已保存到系统相册。", error: false });
    } catch (error) {
      this.setData({ message: error.errMsg || error.message || "原图保存失败，请检查相册权限后重试", error: true });
    } finally {
      wx.hideLoading();
      this.setData({ originalBusySlot: -1 });
    }
  },

  async callPhotoWithTransportRetry(action, payload) {
    try { return await callPhoto(action, payload); }
    catch (error) {
      if (!error.submissionUncertain) throw error;
      return callPhoto(action, payload);
    }
  },

  async uploadExtraPhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    if (!this.data.canEdit || this.data.uploading || this.data.photoLoading || !Number.isInteger(slot) || slot < 2 || slot > 4) return;
    let chosen;
    try {
      chosen = await wxCall((resolve, reject) => wx.chooseMedia({
        count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["original"], success: resolve, fail: reject
      }));
    } catch (error) {
      if (!/cancel/i.test(String(error.errMsg || error.message || ""))) this.setData({ message: error.errMsg || "选择照片失败", error: true });
      return;
    }
    const file = chosen.tempFiles && chosen.tempFiles[0];
    const filePath = file && file.tempFilePath;
    if (!filePath) return;
    const uploadRequestId = requestId(slot);
    let requestOpened = false;
    let commitUncertain = false;
    this.setData({ uploading: true, uploadingSlot: slot, message: "正在校验并保存补充照片…", error: false });
    try {
      const [read, dimensions] = await Promise.all([readFile(filePath), imageInfo(filePath)]);
      const buffer = read.data;
      const bytes = new Uint8Array(buffer);
      const type = clean(dimensions.type).toLowerCase();
      if (!Number.isInteger(bytes.byteLength) || bytes.byteLength < 4 || bytes.byteLength > MAX_EXTRA_PHOTO_BYTES) {
        throw new Error("补充照片须为不超过 3 MB 的 JPEG");
      }
      if (!["jpeg", "jpg"].includes(type) || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        throw new Error("补充照片仅支持 JPEG");
      }
      const begin = await this.callPhotoWithTransportRetry("beginVerificationPhotoUpload", {
        recordId: this.data.order.id, slot, requestId: uploadRequestId, originalBytes: bytes.byteLength
      });
      requestOpened = !begin.alreadyCommitted;
      if (begin.alreadyCommitted) {
        this.setData({ message: "该补充照片已经保存，正在重新读取照片清单。", error: false });
        await this.loadPhotos();
        return;
      }
      if (begin.uploadMode !== "FUNCTION" || !/^[a-f0-9]{64}$/i.test(clean(begin.functionUploadProof))) {
        throw new Error("照片服务没有返回有效的云函数上传授权");
      }
      const imageBase64 = `data:image/jpeg;base64,${wx.arrayBufferToBase64(buffer)}`;
      let committed;
      try {
        committed = await this.callPhotoWithTransportRetry("commitVerificationPhotoUpload", {
          recordId: this.data.order.id, requestId: uploadRequestId, imageBase64, functionUploadProof: begin.functionUploadProof
        });
      } catch (error) {
        commitUncertain = error.submissionUncertain === true;
        let status = null;
        try { status = await callPhoto("getVerificationPhotoUploadStatus", { recordId: this.data.order.id, requestId: uploadRequestId }); }
        catch (_) { status = null; }
        if (status?.status === "COMMITTED") committed = status;
        else {
          if (status?.status === "UPLOADING" || (!commitUncertain && requestOpened)) {
            try { await callPhoto("cancelVerificationPhotoUpload", { recordId: this.data.order.id, requestId: uploadRequestId }); } catch (_) {}
          }
          throw error;
        }
      }
      if (clean(committed?.status) !== "COMMITTED") throw new Error("照片服务没有确认保存结果");
      requestOpened = false;
      this.setData({ message: `${PHOTO_LABELS[slot]}已保存，正在重新读取数据库照片清单。`, error: false });
      await this.loadPhotos();
    } catch (error) {
      if (requestOpened && !commitUncertain) {
        try { await callPhoto("cancelVerificationPhotoUpload", { recordId: this.data.order.id, requestId: uploadRequestId }); } catch (_) {}
      }
      this.setData({ message: error.message || error.errMsg || "补充照片保存失败", error: true });
    } finally { this.setData({ uploading: false, uploadingSlot: -1 }); }
  },

  async getProductLogoData(template, productRef) {
    const expectedReference = clean(template.logo?.reference);
    let response = await callStaff("getProductReceiptLogoData", { productRef, expectedReference });
    let logo = response.logo || {};
    if (logo.chunked && !logo.base64) {
      const bytes = Number(logo.bytes || 0);
      const chunkSize = Number(logo.chunkSize || 0);
      if (!Number.isInteger(bytes) || bytes < 1 || !Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("产品 LOGO 分块信息不完整");
      const chunks = [];
      for (let offset = 0; offset < bytes; offset += chunkSize) {
        const chunkLength = Math.min(chunkSize, bytes - offset);
        response = await callStaff("getProductReceiptLogoData", { productRef, expectedReference, chunkOffset: offset, chunkLength });
        const part = response.logo || {};
        if (Number(part.chunkOffset) !== offset || Number(part.chunkBytes) !== chunkLength || !part.base64) throw new Error("产品 LOGO 分块读取不完整");
        chunks.push(new Uint8Array(wx.base64ToArrayBuffer(part.base64)));
      }
      const merged = concatBytes(chunks);
      if (merged.byteLength !== bytes) throw new Error("产品 LOGO 原图大小不一致");
      logo = { ...logo, base64: wx.arrayBufferToBase64(merged.buffer) };
    }
    const expectedBytes = Number(template.logo?.bytes || 0);
    let logoBytes;
    try { logoBytes = new Uint8Array(wx.base64ToArrayBuffer(logo.base64 || "")); } catch (_) { logoBytes = new Uint8Array(); }
    if (!logo.base64 || !logoBytes.byteLength || (expectedBytes > 0 && logoBytes.byteLength !== expectedBytes)) throw new Error("产品 LOGO 原图读取不完整");
    const mimeType = clean(logo.mimeType || template.logo?.mimeType);
    if (!/^image\/(?:png|jpeg|webp)$/i.test(mimeType)) throw new Error("产品 LOGO 类型无效");
    return `data:${mimeType};base64,${logo.base64}`;
  },

  async loadReceiptTemplate() {
    const productRef = clean(this.data.order.productId || this.data.order.productCode);
    if (!productRef) throw new Error("工单没有可读取的产品编号");
    const response = await callStaff("getProductReceiptTemplate", { productRef });
    const template = response.template;
    if (!template || !clean(template.id)) throw new Error("服务器没有返回产品单据模板");
    if (this.data.order.productId && clean(template.id) !== clean(this.data.order.productId)) throw new Error("产品模板与工单项目不一致");
    if (this.data.order.productCode && clean(template.productCode).toUpperCase() !== clean(this.data.order.productCode).toUpperCase()) {
      throw new Error("产品模板与工单项目不一致");
    }
    const logoSource = template.logo ? await this.getProductLogoData(template, productRef) : "";
    return {
      ...template, logoSource,
      verificationInstructions: normalizedInstructions(template.verificationInstructions),
      rechargeInstructions: normalizedInstructions(template.rechargeInstructions)
    };
  },

  async verificationPhotosForExport() {
    const manifest = await callPhoto("getVerificationPhotos", { recordId: this.data.order.id });
    const normalized = this.applyPhotoManifest(manifest);
    const declared = normalized.slots.filter((photo) => photo.declared);
    let completed = 0;
    const results = await mapWithConcurrency(declared, 2, async (photo) => {
      try {
        const result = await callPhoto("getVerificationPhotoExportData", { recordId: this.data.order.id, slot: photo.slot });
        if (Number(result.slot) !== photo.slot) throw new Error("照片位置与导出请求不一致");
        const image = jpegDataUrl(result.imageBase64, result.bytes);
        if (Number(photo.originalBytes || 0) > 0 && image.bytes !== Number(photo.originalBytes)) throw new Error("照片原图与数据库清单大小不一致");
        return { ok: true, slot: photo.slot, source: image.source };
      } catch (error) {
        return { ok: false, slot: photo.slot, error };
      } finally {
        completed += 1;
        this.setData({ exportProgress: `正在读取核销原图 ${completed}/${declared.length}` });
      }
    });
    const failures = results.filter((item) => !item.ok);
    if (failures.length) {
      const first = failures[0].error?.message || "原图不可用";
      throw new Error(`数据库已登记的核销照片有 ${failures.length} 张读取失败（${first}），本次没有生成文件`);
    }
    const sourceBySlot = new Map(results.map((item) => [item.slot, item.source]));
    return normalized.slots.map((photo) => ({ ...photo, exportSource: sourceBySlot.get(photo.slot) || "" }));
  },

  canvasNode() {
    return new Promise((resolve, reject) => this.createSelectorQuery().select("#receiptCanvas").fields({ node: true, size: true }).exec((items) => {
      if (!items || !items[0] || !items[0].node) reject(new Error("导出画布尚未准备完成"));
      else resolve(items[0].node);
    }));
  },

  async renderSharedReceipt(template, photos, paginate = false) {
    const canvas = await this.canvasNode();
    const documentData = receiptDocumentData(this.data.order, this.data.baseType, template);
    const receiptPhotos = this.data.baseType === "VERIFICATION" ? receiptPhotoItems(photos) : [];
    const receipt = await renderReceiptCanvas({
      canvas,
      documentData,
      photos: receiptPhotos,
      logoSource: template.logoSource || "",
      paginate
    });
    const images = await exportReceiptJpegs(receipt, this);
    return { documentData, images, width: receipt.width, height: receipt.height, pageCount: receipt.pageCount, paginate };
  },

  async readReceiptPdfPages(images) {
    if (!Array.isArray(images) || !images.length) throw new Error("PDF 分页数据无效");
    const pages = [];
    for (const image of images) {
      const source = await readFile(image.path);
      pages.push({ width: image.width, height: image.height, bytes: new Uint8Array(source.data) });
    }
    return pages;
  },

  async exportOrder(format) {
    if (this.data.exporting || !this.data.order) return;
    this.setData({ exporting: true, exportProgress: "正在读取产品单据模板…", message: "", error: false });
    try {
      const templatePromise = this.loadReceiptTemplate();
      const photosPromise = this.data.baseType === "VERIFICATION" ? this.verificationPhotosForExport() : Promise.resolve([]);
      const [template, photos] = await Promise.all([templatePromise, photosPromise]);
      this.setData({ exportProgress: "正在生成业务凭证…" });
      const receipt = await this.renderSharedReceipt(template, photos, format === "pdf");
      const baseName = safeFilename(receipt.documentData.filename);
      if (format === "pdf") {
        this.setData({ exportProgress: `正在写入 ${receipt.pageCount} 页 A4 PDF…` });
        const pages = await this.readReceiptPdfPages(receipt.images);
        const pdf = jpegPdf(pages);
        const filePath = `${wx.env.USER_DATA_PATH}/${baseName}.pdf`;
        await writeFile(filePath, pdf);
        this.setData({ exportProgress: "正在打开 PDF…" });
        await openPdfDocument(filePath);
      } else {
        await saveImageToAlbum(receipt.images[0].path);
      }
      this.setData({
        message: format === "pdf" ? "PDF 凭证已打开，可通过右上角菜单分享或保存。" : "图片凭证已保存到相册。",
        error: false
      });
    } catch (error) {
      if (/cancel/i.test(String(error.errMsg || error.message || ""))) this.setData({ message: "已取消导出。", error: false });
      else this.setData({ message: error.message || error.errMsg || "业务凭证生成失败", error: true });
    } finally { this.setData({ exporting: false, exportProgress: "" }); }
  },

  exportPdf() { return this.exportOrder("pdf"); },
  exportImage() { return this.exportOrder("image"); },

  openCustomer() {
    if (this.data.order?.customerCode) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(this.data.order.customerCode)}` });
  },
  openFact(event) { if (event.currentTarget.dataset.label === "客户") this.openCustomer(); }
});

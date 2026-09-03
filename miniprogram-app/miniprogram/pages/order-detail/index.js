const { callFace, callPhoto, callStaff, callRating } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");
const submission = require("../../services/submission");
const { saveImageToAlbum, isPermissionFailure } = require("../../services/photo-album");
const {
  renderReceiptCanvas,
  exportReceiptJpegs,
  createPdfBytes: jpegPdf,
  safeFilename
} = require("../../services/order-receipt");

const PHOTO_SLOT_COUNT = 5;
const DETAIL_PHOTO_SLOTS = Object.freeze([1, 2, 3, 4]);
const MAX_EXTRA_SOURCE_PHOTO_BYTES = 7 * 1024 * 1024;
const MAX_EXTRA_UPLOAD_PHOTO_BYTES = 3 * 1024 * 1024;
const ORIGINAL_PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_PHOTO_CACHE_STORAGE_KEY = "order-original-photo-cache-v1";
const PHOTO_LABELS = Object.freeze(["客户建档留存照", "客户核销照片", "补充照片 1", "补充照片 2", "补充照片 3"]);

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

function receiptDocumentData(order, baseType, template, ratingQrSource = "") {
  const source = order || {};
  const recharge = clean(baseType).toUpperCase() === "RECHARGE";
  const refund = recharge && clean(source.originalType).toUpperCase() === "REFUND";
  const supplement = !recharge && clean(source.originalType).toUpperCase() === "SUPPLEMENT";
  const reviewVisible = recharge || supplement;
  const businessName = refund ? "退费" : recharge ? "充值" : "核销";
  const customerIdentity = [clean(source.customerName), clean(source.customerCode)].filter(Boolean).join(" · ") || "—";
  const facts = [
    { label: "客户", value: customerIdentity, singleLine: true },
    { label: "项目", value: source.productName, singleLine: true },
    { label: "门店", value: source.storeName, singleLine: true },
    { label: "业务老师", value: source.teacherName || "未指定", singleLine: true }
  ];
  const details = recharge ? [
    { label: refund ? "退费次数" : "充值次数", value: `${Number(source.unitCount || 0)} 次` },
    { label: "提交时间", value: source.submittedAt || "—" },
    { label: "审核时间", value: source.reviewedAt || "—" }
  ] : [
    { label: "工单类型", value: source.typeLabel || "核销" },
    { label: "次数", value: `${Number(source.unitCount || 0)} 次` },
    { label: "提交时间", value: source.submittedAt || "—", span: 2 }
  ];
  const productGifts = recharge ? normalizeProductGifts(source.productGifts) : [];
  // 客户可下载的 PDF／图片凭证只包含业务事实，任何门店、审核、补录或作废留言都不得进入导出模型。
  const messages = [];
  return {
    filename: `${source.customerName || "客户"}+${source.productName || "项目"}+${businessName}`,
    kind: source.typeLabel || businessName,
    title: `${refund ? "退费单" : recharge ? "充值单" : "核销单"} ${source.recordCode || "—"}`,
    subtitle: `门店详细地址：${source.storeAddress || "未填写"}`,
    facts,
    customerFacing: true,
    compactVerification: !recharge,
    detailTitle: refund ? "退费信息" : recharge ? "充值信息" : "核销信息",
    detailSubtitle: refund ? "退费次数与办理时间" : recharge ? "充值次数与办理时间" : "核销次数与办理时间",
    details,
    productGifts,
    messages,
    ratingQr: ratingQrSource ? {
      source: ratingQrSource,
      title: "扫码评价本次服务",
      description: "请选择门店环境、老师服务和整体体验 1–5 星，可填写文字留言。"
    } : null,
    productTemplate: {
      productName: template.productName || source.productName || "产品",
      productType: template.productType || "未分类",
      instructions: recharge ? template.rechargeInstructions : template.verificationInstructions,
      logoRequired: Boolean(template.logo)
    }
  };
}

function stars(score) {
  const value = Math.max(0, Math.min(5, Number(score) || 0));
  return `${"★".repeat(value)}${"☆".repeat(5 - value)}`;
}

function emptyRating() {
  return {
    submitted: false,
    requiresTeacherScore: false,
    storeEnvironmentScore: 0,
    teacherServiceScore: 0,
    overallExperienceScore: 0,
    storeEnvironmentStars: "",
    teacherServiceStars: "",
    overallExperienceStars: "",
    customerComment: "",
    submittedAtLabel: "—"
  };
}

function normalizeCustomerRating(result = {}) {
  const submitted = result.submitted === true || clean(result.ratingStatus).toUpperCase() === "SUBMITTED";
  if (!submitted) return { ...emptyRating(), requiresTeacherScore: result.requiresTeacherScore === true };
  const storeEnvironmentScore = Number(result.storeEnvironmentScore || 0);
  const teacherServiceScore = Number(result.teacherServiceScore || 0);
  const overallExperienceScore = Number(result.overallExperienceScore || 0);
  return {
    submitted: true,
    requiresTeacherScore: result.requiresTeacherScore === true,
    storeEnvironmentScore,
    teacherServiceScore,
    overallExperienceScore,
    storeEnvironmentStars: stars(storeEnvironmentScore),
    teacherServiceStars: stars(teacherServiceScore),
    overallExperienceStars: stars(overallExperienceScore),
    customerComment: clean(result.customerComment),
    submittedAtLabel: query.displayDateTimeAny(result.submittedAt, result.submitted_at)
  };
}

function labelsForManifest(result, noun = "核销") {
  const labels = [...PHOTO_LABELS];
  if (clean(result?.faceSubjectType).toUpperCase() === "TEACHER") {
    labels[0] = "老师登记照";
    labels[1] = "老师核销照片";
  } else {
    labels[1] = `${clean(noun) || "核销"}现场照`;
  }
  return labels;
}

function buildPhotoSlots(state = "empty", labels = PHOTO_LABELS) {
  return Array.from({ length: PHOTO_SLOT_COUNT }, (_, slot) => ({
    slot,
    label: labels[slot] || `照片 ${slot + 1}`,
    visible: DETAIL_PHOTO_SLOTS.includes(slot),
    state,
    declared: false,
    thumbnailState: state === "loading" ? "loading" : "empty",
    thumbnailUrl: "",
    retrying: false,
    retryError: "",
    originalBusy: false,
    originalAction: ""
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
      retrying: false,
      retryError: "",
      originalBusy: false,
      originalAction: ""
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
    reviewedAt: query.displayDateTimeAny(
      source.reviewedAt, source.reviewed_at, source.originalReviewedAt, source.original_reviewed_at,
      source.approvedAt, source.approved_at, source.reviewTime, source.review_time
    ),
    storeAddress: address || "未填写",
    message: clean(value(source, "initial_store_note", "initialStoreNote")),
    reviewNote: clean(value(source, "initial_review_note", "initialReviewNote")),
    supplementNote: clean(value(source, "supplement_note", "supplementNote")),
    balanceBeforeLabel: optionalNumber(value(source, "balance_before_count", "balanceBeforeCount")),
    balanceAfterLabel: optionalNumber(value(source, "balance_after_count", "balanceAfterCount")),
    voidStatus: clean(value(source, "void_request_status", "voidRequestStatus")),
    voidNote: clean(value(source, "void_request_note", "voidRequestNote")),
    voidReviewNote: clean(value(source, "void_review_note", "voidReviewNote")),
    voidSubmittedAt: query.displayDateTimeAny(source.voidRequestedAt, source.void_requested_at),
    voidReviewedAt: query.displayDateTimeAny(source.voidReviewedAt, source.void_reviewed_at),
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
    reviewedAt: query.displayDateTimeAny(
      source.reviewedAt, source.reviewed_at, source.originalReviewedAt, source.original_reviewed_at,
      source.approvedAt, source.approved_at
    ),
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
function copyFile(srcPath, destPath) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().copyFile({ srcPath, destPath, success: resolve, fail: reject }));
}
function unlinkFile(filePath) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().unlink({ filePath, success: resolve, fail: reject }));
}
function fileInfo(filePath) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath, success: resolve, fail: reject }));
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
function imageFormat(bytes) {
  if (!(bytes instanceof Uint8Array)) return "";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return "";
}
function loadCanvasImage(canvas, source) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("当前微信版本无法读取这张照片，请改选 JPG、PNG 或 WebP 图片"));
    image.src = source;
  });
}
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

function photoPreviewPath(recordId, slot, token = "") {
  const safeRecord = clean(recordId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "record";
  const safeToken = clean(token).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "page";
  return `${wx.env.USER_DATA_PATH}/order-photo-preview-${safeRecord}-${Number(slot)}-${safeToken}.jpg`;
}

function originalPhotoCacheKey(recordId, slot) {
  return `${clean(recordId)}:${Number(slot)}`;
}

function shortHash(input) {
  let hash = 2166136261;
  const source = String(input || "");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function photoManifestIdentity(photo) {
  if (!photo?.declared) return "empty";
  return [
    "declared",
    clean(photo.uploadedAt || photo.uploaded_at || photo.updatedAt || photo.updated_at),
    Number(photo.originalBytes || photo.original_bytes || 0),
    clean(photo.objectKey || photo.object_key || photo.originalObjectRef || photo.original_object_ref),
    clean(photo.etag || photo.sha256)
  ].join("|");
}

function originalPhotoFilePath(recordId, slot, token, sequence) {
  const safeRecord = clean(recordId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "record";
  const safeToken = clean(token).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "page";
  return `${wx.env.USER_DATA_PATH}/order-photo-${safeRecord}-${Number(slot)}-${safeToken}-${Number(sequence)}.jpg`;
}

function persistentOriginalPhotoFilePath(recordId, slot, identity) {
  const safeRecord = clean(recordId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "record";
  return `${wx.env.USER_DATA_PATH}/order-photo-cache-${safeRecord}-${Number(slot)}-${shortHash(identity)}.jpg`;
}

function readOriginalPhotoCacheIndex() {
  try {
    const stored = typeof wx.getStorageSync === "function" ? wx.getStorageSync(ORIGINAL_PHOTO_CACHE_STORAGE_KEY) : {};
    return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};
  } catch (_) { return {}; }
}

function writeOriginalPhotoCacheIndex(index) {
  try {
    if (typeof wx.setStorageSync === "function") wx.setStorageSync(ORIGINAL_PHOTO_CACHE_STORAGE_KEY, index || {});
  } catch (_) {}
}

function originalDownloadDomainFailure(error) {
  return /domain list|合法域名|not in domain|url not in/i.test(clean(error?.errMsg || error?.message));
}

function originalPhotoErrorMessage(error, fallback = "原图读取失败，请稍后重试") {
  const message = clean(error?.message || error?.errMsg);
  if (/cancel/i.test(message)) return "";
  if (originalDownloadDomainFailure(error)) return "原图下载地址暂不可用，已尝试安全读取；请稍后重试。";
  if (isPermissionFailure(error)) return "没有相册权限，请允许访问照片后重试。";
  if (message && !/^[A-Za-z][\s\S]*$/.test(message) && !/:fail/i.test(message)) return message;
  return fallback;
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
    photos: buildPhotoSlots(), photoCount: 0, visiblePhotoCount: 0, photoLoading: false, photoManifestLoaded: false, photoManifestError: "",
    canEdit: false, isSubmitter: false, editableUntil: "", editableUntilLabel: "—", uploading: false, uploadingSlot: -1,
    exporting: false, exportProgress: "",
    rating: emptyRating(), ratingLoading: false, ratingError: "",
    photoViewerOpen: false, photoViewerPath: "", photoViewerSlot: -1, photoViewerLabel: "",
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
    this._photoLoadEpoch = 0;
    this._photoRetrySequence = new Map();
    this._originalPhotoFlights = new Map();
    this._originalPhotoCache = new Map();
    this._originalPhotoGenerations = new Map();
    this._photoManifestIdentities = new Map();
    this._persistentOriginalPhotoIndex = readOriginalPhotoCacheIndex();
    this._ownedPhotoFiles = new Set();
    this._photoPageToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this._photoFileSequence = 0;
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    this.load();
  },

  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  onUnload() {
    this._photoLoadEpoch = Number(this._photoLoadEpoch || 0) + 1;
    if (this._photoRetrySequence) this._photoRetrySequence.clear();
    if (this._originalPhotoFlights) this._originalPhotoFlights.clear();
    if (this._originalPhotoCache) this._originalPhotoCache.clear();
    if (this._originalPhotoGenerations) this._originalPhotoGenerations.clear();
    if (this._photoManifestIdentities) this._photoManifestIdentities.clear();
    this.setData({ photoViewerOpen: false, photoViewerPath: "", photoViewerSlot: -1, photoViewerLabel: "" });
    const owned = this._ownedPhotoFiles ? Array.from(this._ownedPhotoFiles) : [];
    if (this._ownedPhotoFiles) this._ownedPhotoFiles.clear();
    owned.forEach((filePath) => unlinkFile(filePath).catch(() => {}));
  },

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
    this._photoLoadEpoch = Number(this._photoLoadEpoch || 0) + 1;
    this.setData({
      loading: "locked", message: "", error: false,
      ...(verification ? {
        photos: buildPhotoSlots("loading"), photoCount: 0, visiblePhotoCount: 0, photoManifestLoaded: false, photoManifestError: "",
        canEdit: false, isSubmitter: false, editableUntil: "", editableUntilLabel: "—",
        rating: emptyRating(), ratingLoading: true, ratingError: ""
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
      if (verification) await Promise.all([this.loadPhotos(), this.loadRating()]);
    } catch (error) {
      this.setData({ order: null, loading: false, message: error.message || "工单详情读取失败", error: true });
    }
  },

  applyPhotoManifest(result) {
    const normalized = normalizePhotoManifest(result, labelsForManifest(result, this.data.noun));
    this.ensureOriginalPhotoState();
    const recordId = clean(this.data.order?.id);
    if (recordId) normalized.slots.forEach((photo) => {
      const key = originalPhotoCacheKey(recordId, photo.slot);
      const identity = photoManifestIdentity(photo);
      const previous = this._photoManifestIdentities.get(key);
      if (previous !== undefined && previous !== identity) void this.clearOriginalPhotoCache(photo.slot, recordId);
      this._photoManifestIdentities.set(key, identity);
    });
    this.setData({
      photos: normalized.slots,
      photoCount: normalized.count,
      visiblePhotoCount: normalized.slots.filter((photo) => photo.visible && photo.declared).length,
      photoManifestLoaded: true,
      photoManifestError: "",
      canEdit: result.canEdit === true, isSubmitter: result.isSubmitter === true,
      editableUntil: result.editableUntil || "", editableUntilLabel: query.displayDateTimeAny(result.editableUntil, result.editable_until)
    });
    return normalized;
  },

  async loadPhotos() {
    if (this.data.photoLoading || !this.data.order?.id) return false;
    const hadManifest = this.data.photoManifestLoaded;
    this.setData({
      photoLoading: true, photoManifestError: "",
      ...(!hadManifest ? { photos: buildPhotoSlots("loading", labelsForManifest({}, this.data.noun)), photoCount: 0, visiblePhotoCount: 0 } : {})
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
          photos: buildPhotoSlots("list-error", labelsForManifest({}, this.data.noun)), photoCount: 0, visiblePhotoCount: 0,
          photoManifestLoaded: false, canEdit: false, isSubmitter: false, editableUntil: "", editableUntilLabel: "—"
        } : {}),
        message, error: true
      });
      return false;
    } finally { this.setData({ photoLoading: false }); }
  },

  retryPhotoList() {
    if (this.data.uploading || this.data.exporting || this.data.photos.some((photo) => photo.retrying)) return false;
    return this.loadPhotos();
  },

  async loadRating() {
    if (this.data.baseType !== "VERIFICATION" || !this.data.order?.id || this.data.ratingLoading === "locked") return false;
    const recordId = clean(this.data.order.id);
    this.setData({ ratingLoading: "locked", ratingError: "" });
    if (!["NORMAL", "EXPERIENCE"].includes(clean(this.data.order.originalType).toUpperCase())) {
      this.setData({ rating: emptyRating(), ratingLoading: false, ratingError: "" });
      return true;
    }
    try {
      const result = await callRating("getForStaff", { verificationId: recordId });
      if (clean(this.data.order?.id) !== recordId) return false;
      this.setData({ rating: normalizeCustomerRating(result), ratingLoading: false, ratingError: "" });
      return true;
    } catch (error) {
      if (clean(this.data.order?.id) !== recordId) return false;
      this.setData({ rating: emptyRating(), ratingLoading: false, ratingError: error.message || "客户评价读取失败" });
      return false;
    }
  },

  retryRating() {
    if (this.data.ratingLoading || !this.data.order?.id) return false;
    return this.loadRating();
  },

  updatePhotoSlot(slot, changes) {
    this.setData({ photos: this.data.photos.map((photo) => Number(photo.slot) === Number(slot) ? { ...photo, ...changes } : photo) });
  },

  photoThumbnailError(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    const photo = this.data.photos.find((item) => item.slot === slot);
    if (photo?.declared) this.updatePhotoSlot(slot, {
      thumbnailState: "error", thumbnailUrl: "", retrying: false,
      retryError: "图片地址已失效，点击此照片重新加载"
    });
  },

  async retryThumbnail(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    const photo = this.data.photos.find((item) => item.slot === slot);
    const orderId = clean(this.data.order?.id);
    if (!photo?.declared || photo.retrying || !orderId) return;
    const epoch = Number(this._photoLoadEpoch || 0);
    const sequence = Number(this._photoRetrySequence?.get(slot) || 0) + 1;
    this._photoRetrySequence.set(slot, sequence);
    this.updatePhotoSlot(slot, { retrying: true, retryError: "" });
    try {
      const result = await callPhoto("getVerificationPhotoThumbnailData", { recordId: orderId, slot });
      if (Number(result.slot) !== slot) throw new Error("缩略图位置与请求不一致");
      const image = jpegDataUrl(result.imageBase64, result.bytes);
      this.ensureOriginalPhotoState();
      const localPath = photoPreviewPath(orderId, slot, this._photoPageToken);
      await writeFile(localPath, image.buffer);
      this._ownedPhotoFiles.add(localPath);
      if (epoch !== Number(this._photoLoadEpoch || 0)
        || sequence !== Number(this._photoRetrySequence?.get(slot) || 0)
        || clean(this.data.order?.id) !== orderId) return;
      this.updatePhotoSlot(slot, {
        thumbnailUrl: localPath,
        thumbnailState: "ready",
        retrying: false,
        retryError: ""
      });
    } catch (error) {
      if (epoch !== Number(this._photoLoadEpoch || 0)
        || sequence !== Number(this._photoRetrySequence?.get(slot) || 0)
        || clean(this.data.order?.id) !== orderId) return;
      this.updatePhotoSlot(slot, {
        thumbnailUrl: "",
        thumbnailState: "error",
        retrying: false,
        retryError: error.message || "该照片暂时无法读取，请点击重试"
      });
    }
  },

  ensureOriginalPhotoState() {
    if (!this._originalPhotoFlights) this._originalPhotoFlights = new Map();
    if (!this._originalPhotoCache) this._originalPhotoCache = new Map();
    if (!this._originalPhotoGenerations) this._originalPhotoGenerations = new Map();
    if (!this._photoManifestIdentities) this._photoManifestIdentities = new Map();
    if (!this._persistentOriginalPhotoIndex || typeof this._persistentOriginalPhotoIndex !== "object") {
      this._persistentOriginalPhotoIndex = readOriginalPhotoCacheIndex();
    }
    if (!this._ownedPhotoFiles) this._ownedPhotoFiles = new Set();
    if (!this._photoPageToken) this._photoPageToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!Number.isFinite(this._photoFileSequence)) this._photoFileSequence = 0;
  },

  async clearOriginalPhotoCache(slot, recordId = clean(this.data.order?.id)) {
    this.ensureOriginalPhotoState();
    const key = originalPhotoCacheKey(recordId, slot);
    const generation = Number(this._originalPhotoGenerations.get(key) || 0) + 1;
    this._originalPhotoGenerations.set(key, generation);
    const cached = this._originalPhotoCache.get(key);
    this._originalPhotoCache.delete(key);
    const flight = this._originalPhotoFlights.get(key);
    if (flight && Number(flight.generation) !== generation) this._originalPhotoFlights.delete(key);
    const filePath = typeof cached === "string" ? cached : clean(cached?.filePath);
    if (filePath && this._ownedPhotoFiles.has(filePath)) {
      this._ownedPhotoFiles.delete(filePath);
      await unlinkFile(filePath).catch(() => {});
    }
    const persistent = this._persistentOriginalPhotoIndex[key];
    if (persistent) {
      delete this._persistentOriginalPhotoIndex[key];
      writeOriginalPhotoCacheIndex(this._persistentOriginalPhotoIndex);
      const persistentPath = clean(persistent.filePath);
      if (persistentPath && persistentPath !== filePath) await unlinkFile(persistentPath).catch(() => {});
    }
  },

  async originalPhotoSource(slot, recordId) {
    const photo = this.data.photos.find((item) => Number(item.slot) === Number(slot));
    if (!photo?.declared) throw new Error("该照片位置尚未上传");
    const result = await callPhoto("getVerificationPhotoOriginalUrl", { recordId, slot });
    if (result.slot !== undefined && Number(result.slot) !== Number(slot)) throw new Error("原图位置与请求不一致");
    const source = clean(result.photoUrl);
    const expectedBytes = Number(result.originalBytes || photo.originalBytes || 0);
    if (/^https:\/\//i.test(source)) return { source, buffer: null, expectedBytes };
    const image = jpegDataUrl(source, expectedBytes);
    return { source: "", buffer: image.buffer, expectedBytes: image.bytes };
  },

  async originalPhotoInlineSource(slot, recordId) {
    const result = await callPhoto("getVerificationPhotoExportData", {
      recordId,
      slot,
      requestId: requestId(slot)
    });
    if (result.slot !== undefined && Number(result.slot) !== Number(slot)) throw new Error("原图位置与请求不一致");
    const image = jpegDataUrl(result.imageBase64, result.bytes);
    return { source: "", buffer: image.buffer, expectedBytes: image.bytes };
  },

  async persistentOriginalPhotoPath(slot, recordId, identity, expectedBytes = 0) {
    this.ensureOriginalPhotoState();
    const key = originalPhotoCacheKey(recordId, slot);
    const entry = this._persistentOriginalPhotoIndex[key];
    if (!entry) return "";
    const filePath = clean(entry.filePath);
    const validMetadata = clean(entry.identity) === clean(identity)
      && Number(entry.expiresAt || 0) > Date.now()
      && filePath;
    if (validMetadata) {
      try {
        const info = await fileInfo(filePath);
        const recordedBytes = Number(expectedBytes || entry.bytes || 0);
        if (recordedBytes > 0 && Number(info.size || 0) !== recordedBytes) throw new Error("缓存文件大小不一致");
        return filePath;
      } catch (_) {}
    }
    delete this._persistentOriginalPhotoIndex[key];
    writeOriginalPhotoCacheIndex(this._persistentOriginalPhotoIndex);
    if (filePath) await unlinkFile(filePath).catch(() => {});
    return "";
  },

  async localOriginalPath(slot, recordId, identity, resolved) {
    this.ensureOriginalPhotoState();
    const key = originalPhotoCacheKey(recordId, slot);
    const filePath = persistentOriginalPhotoFilePath(recordId, slot, identity);
    await unlinkFile(filePath).catch(() => {});
    if (resolved.buffer) {
      await writeFile(filePath, resolved.buffer);
    } else {
      try {
        const downloaded = await wxCall((resolve, reject) => wx.downloadFile({ url: resolved.source, success: resolve, fail: reject }));
        if (Number(downloaded.statusCode) !== 200 || !clean(downloaded.tempFilePath)) throw new Error("原图下载失败");
        await copyFile(clean(downloaded.tempFilePath), filePath);
      } catch (error) {
        if (!originalDownloadDomainFailure(error)) throw error;
        const inline = await this.originalPhotoInlineSource(slot, recordId);
        resolved = inline;
        await writeFile(filePath, inline.buffer);
      }
    }
    try {
      const info = await fileInfo(filePath);
      const actualBytes = Number(info.size || 0);
      if (Number(resolved.expectedBytes || 0) > 0 && actualBytes !== Number(resolved.expectedBytes)) {
        throw new Error("原图与数据库记录大小不一致");
      }
    } catch (error) {
      await unlinkFile(filePath).catch(() => {});
      throw error;
    }
    this._persistentOriginalPhotoIndex[key] = {
      filePath,
      identity,
      bytes: Number(resolved.expectedBytes || 0),
      cachedAt: Date.now(),
      expiresAt: Date.now() + ORIGINAL_PHOTO_CACHE_TTL_MS
    };
    writeOriginalPhotoCacheIndex(this._persistentOriginalPhotoIndex);
    return filePath;
  },

  async originalPhotoLocalPath(slot, { refresh = false } = {}) {
    this.ensureOriginalPhotoState();
    const recordId = clean(this.data.order?.id);
    if (!recordId || !Number.isInteger(Number(slot))) throw new Error("工单照片参数无效");
    const photo = this.data.photos.find((item) => Number(item.slot) === Number(slot));
    if (!photo?.declared) throw new Error("该照片位置尚未上传");
    const identity = photoManifestIdentity(photo);
    const expectedBytes = Number(photo.originalBytes || photo.original_bytes || 0);
    const key = originalPhotoCacheKey(recordId, slot);
    if (refresh) await this.clearOriginalPhotoCache(slot, recordId);
    let generation = Number(this._originalPhotoGenerations.get(key) || 0);
    const cached = this._originalPhotoCache.get(key);
    if (cached) {
      const cachedPath = typeof cached === "string" ? cached : clean(cached.filePath);
      const cachedGeneration = typeof cached === "string" ? generation : Number(cached.generation);
      if (cachedPath && cachedGeneration === generation) {
        try {
          await fileInfo(cachedPath);
          if (Number(this._originalPhotoGenerations.get(key) || 0) === generation
            && this._originalPhotoCache.get(key) === cached) return cachedPath;
        } catch (_) {
          if (Number(this._originalPhotoGenerations.get(key) || 0) === generation
            && this._originalPhotoCache.get(key) === cached) await this.clearOriginalPhotoCache(slot, recordId);
        }
      }
      if (this._originalPhotoCache.get(key) === cached) this._originalPhotoCache.delete(key);
      if (cachedPath && this._ownedPhotoFiles.has(cachedPath)) {
        this._ownedPhotoFiles.delete(cachedPath);
        await unlinkFile(cachedPath).catch(() => {});
      }
      generation = Number(this._originalPhotoGenerations.get(key) || 0);
    }
    const persistentPath = await this.persistentOriginalPhotoPath(slot, recordId, identity, expectedBytes);
    if (persistentPath) {
      this._originalPhotoCache.set(key, { generation, filePath: persistentPath, persistent: true, identity });
      return persistentPath;
    }
    const existing = this._originalPhotoFlights.get(key);
    if (existing && Number(existing.generation) === generation) return existing.promise;
    const epoch = Number(this._photoLoadEpoch || 0);
    const promise = (async () => {
      const resolved = await this.originalPhotoSource(Number(slot), recordId);
      const filePath = await this.localOriginalPath(Number(slot), recordId, identity, resolved);
      const generationChanged = Number(this._originalPhotoGenerations.get(key) || 0) !== generation;
      if (epoch !== Number(this._photoLoadEpoch || 0) || clean(this.data.order?.id) !== recordId || generationChanged) {
        delete this._persistentOriginalPhotoIndex[key];
        writeOriginalPhotoCacheIndex(this._persistentOriginalPhotoIndex);
        await unlinkFile(filePath).catch(() => {});
        const error = new Error(generationChanged ? "照片已更新，旧原图读取结果已丢弃" : "工单已切换，旧照片读取结果已丢弃");
        error.code = generationChanged ? "STALE_PHOTO_GENERATION" : "STALE_PHOTO_PAGE";
        throw error;
      }
      this._originalPhotoCache.set(key, { generation, filePath, persistent: true, identity });
      return filePath;
    })();
    const flight = { generation, promise };
    this._originalPhotoFlights.set(key, flight);
    try { return await promise; }
    finally {
      if (this._originalPhotoFlights.get(key) === flight) this._originalPhotoFlights.delete(key);
    }
  },

  async runOriginalPhotoAction(slot, action) {
    const filePath = await this.originalPhotoLocalPath(slot);
    await action(filePath);
    return filePath;
  },

  setOriginalPhotoBusy(slot, busy, action = "") {
    this.updatePhotoSlot(slot, { originalBusy: busy, originalAction: busy ? action : "" });
  },

  async previewPhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    const photo = this.data.photos.find((item) => Number(item.slot) === slot);
    if (!Number.isInteger(slot) || !photo?.declared || photo.originalBusy) return;
    this.setOriginalPhotoBusy(slot, true, "preview");
    this.setData({ message: "", error: false });
    try {
      const filePath = await this.originalPhotoLocalPath(slot);
      this.setData({
        photoViewerOpen: true,
        photoViewerPath: filePath,
        photoViewerSlot: slot,
        photoViewerLabel: photo.label || "核销照片"
      });
    } catch (error) {
      const message = originalPhotoErrorMessage(error);
      if (message) this.setData({ message, error: true });
    } finally { this.setOriginalPhotoBusy(slot, false); }
  },

  async savePhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    const photo = this.data.photos.find((item) => Number(item.slot) === slot);
    if (!Number.isInteger(slot) || !photo?.declared || photo.originalBusy) return;
    this.setOriginalPhotoBusy(slot, true, "save");
    this.setData({ message: "", error: false });
    try {
      await this.runOriginalPhotoAction(slot, (filePath) => saveImageToAlbum(filePath));
      this.setData({ message: "原图已保存到系统相册。", error: false });
    } catch (error) {
      const message = originalPhotoErrorMessage(error, "原图保存失败，请检查相册权限后重试");
      if (message) this.setData({ message, error: true });
    } finally { this.setOriginalPhotoBusy(slot, false); }
  },

  async shareImageFile(filePath) {
    if (typeof wx.showShareImageMenu !== "function") throw new Error("当前微信版本暂不支持转发图片，请升级微信后重试");
    return wxCall((resolve, reject) => wx.showShareImageMenu({ path: filePath, success: resolve, fail: reject }));
  },

  async sharePhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    const photo = this.data.photos.find((item) => Number(item.slot) === slot);
    if (!Number.isInteger(slot) || !photo?.declared || photo.originalBusy) return;
    this.setOriginalPhotoBusy(slot, true, "share");
    this.setData({ message: "", error: false });
    try { await this.runOriginalPhotoAction(slot, (filePath) => this.shareImageFile(filePath)); }
    catch (error) {
      const message = originalPhotoErrorMessage(error, "照片转发失败，请稍后重试");
      if (message) this.setData({ message, error: true });
    } finally { this.setOriginalPhotoBusy(slot, false); }
  },

  closePhotoViewer() {
    this.setData({ photoViewerOpen: false, photoViewerPath: "", photoViewerSlot: -1, photoViewerLabel: "" });
  },

  stopViewerEvent() {},

  async saveViewerPhoto() {
    const slot = Number(this.data.photoViewerSlot);
    if (!Number.isInteger(slot) || slot < 0) return;
    try {
      await this.runOriginalPhotoAction(slot, (filePath) => saveImageToAlbum(filePath));
      this.setData({ message: "原图已保存到系统相册。", error: false });
    } catch (error) {
      const message = originalPhotoErrorMessage(error, "原图保存失败，请检查相册权限后重试");
      if (message) this.setData({ message, error: true });
    }
  },

  async shareViewerPhoto() {
    const slot = Number(this.data.photoViewerSlot);
    if (!Number.isInteger(slot) || slot < 0) return;
    try { await this.runOriginalPhotoAction(slot, (filePath) => this.shareImageFile(filePath)); }
    catch (error) {
      const message = originalPhotoErrorMessage(error, "照片转发失败，请稍后重试");
      if (message) this.setData({ message, error: true });
    }
  },

  async callPhotoWithTransportRetry(action, payload) {
    try { return await callPhoto(action, payload); }
    catch (error) {
      if (!error.submissionUncertain) throw error;
      return callPhoto(action, payload);
    }
  },

  photoNormalizeCanvasNode() {
    return new Promise((resolve, reject) => this.createSelectorQuery().select("#photoNormalizeCanvas").fields({ node: true, size: true }).exec((items) => {
      if (!items || !items[0] || !items[0].node) reject(new Error("照片处理画布尚未准备完成，请稍后重试"));
      else resolve(items[0].node);
    }));
  },

  canvasPhotoJpeg(canvas, width, height, quality) {
    return wxCall((resolve, reject) => wx.canvasToTempFilePath({
      canvas, x: 0, y: 0, width, height, destWidth: width, destHeight: height,
      fileType: "jpg", quality, success: resolve, fail: reject
    }, this));
  },

  async normalizeExtraPhoto(filePath, sourceBuffer, dimensions) {
    const sourceBytes = new Uint8Array(sourceBuffer);
    if (!Number.isInteger(sourceBytes.byteLength) || sourceBytes.byteLength < 12
        || sourceBytes.byteLength > MAX_EXTRA_SOURCE_PHOTO_BYTES) {
      throw new Error("补充照片单张不能超过 7 MB");
    }
    const format = imageFormat(sourceBytes);
    if (!format) throw new Error("补充照片支持 JPG、JPEG、PNG 或 WebP");
    if (format === "jpeg" && sourceBytes.byteLength <= MAX_EXTRA_UPLOAD_PHOTO_BYTES) {
      return { buffer: sourceBuffer, bytes: sourceBytes.byteLength, converted: false };
    }

    const sourceWidth = Number(dimensions?.width || 0);
    const sourceHeight = Number(dimensions?.height || 0);
    if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight)
        || sourceWidth < 1 || sourceHeight < 1 || sourceWidth > 10000 || sourceHeight > 10000) {
      throw new Error("补充照片尺寸无效，请重新选择");
    }
    const canvas = await this.photoNormalizeCanvasNode();
    const image = await loadCanvasImage(canvas, filePath);
    const maxEdges = [2400, 2000, 1600, 1280];
    const qualities = [0.92, 0.86, 0.78, 0.7];
    for (const maxEdge of maxEdges) {
      const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      for (const quality of qualities) {
        const output = await this.canvasPhotoJpeg(canvas, width, height, quality);
        const read = await readFile(output.tempFilePath);
        const bytes = new Uint8Array(read.data);
        if (imageFormat(bytes) === "jpeg" && bytes.byteLength <= MAX_EXTRA_UPLOAD_PHOTO_BYTES) {
          return { buffer: read.data, bytes: bytes.byteLength, converted: true };
        }
      }
    }
    throw new Error("照片转换后仍然过大，请选择内容更简单或尺寸更小的照片");
  },

  async uploadExtraPhotoDirect(upload, buffer) {
    const url = clean(upload?.url || upload?.signedUrl);
    const method = clean(upload?.method || "PUT").toUpperCase();
    const expectedBytes = Number(upload?.expectedBytes || 0);
    if (!/^https:\/\//i.test(url) || method !== "PUT") {
      throw new Error("照片服务没有返回有效的签名直传地址");
    }
    if (expectedBytes > 0 && expectedBytes !== new Uint8Array(buffer).byteLength) {
      throw new Error("补充照片大小与服务器授权不一致，请重新选择");
    }
    const response = await wxCall((resolve, reject) => wx.request({
      url,
      method: "PUT",
      data: buffer,
      header: { "Content-Type": "image/jpeg" },
      responseType: "text",
      timeout: 180000,
      success: resolve,
      fail: reject
    }));
    if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
      throw new Error(`补充照片直传失败（HTTP ${response.statusCode || "—"}）`);
    }
  },

  async uploadExtraPhoto(event) {
    const slot = Number(event.currentTarget.dataset.slot);
    const photo = this.data.photos.find((item) => Number(item.slot) === slot);
    if (!this.data.canEdit || this.data.uploading || this.data.photoLoading || photo?.originalBusy
      || !Number.isInteger(slot) || slot < 2 || slot > 4) return;
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
      const normalized = await this.normalizeExtraPhoto(filePath, read.data, dimensions);
      const buffer = normalized.buffer;
      const bytes = new Uint8Array(buffer);
      const begin = await this.callPhotoWithTransportRetry("beginVerificationPhotoUpload", {
        recordId: this.data.order.id, slot, requestId: uploadRequestId, originalBytes: bytes.byteLength
      });
      requestOpened = !begin.alreadyCommitted;
      if (begin.alreadyCommitted) {
        this.setData({ message: "该补充照片已经保存，正在重新读取照片清单。", error: false });
        await this.clearOriginalPhotoCache(slot);
        await this.loadPhotos();
        return;
      }
      if (begin.uploadMode !== "DIRECT" || !begin.originalUpload) {
        throw new Error("照片服务没有返回有效的签名直传授权");
      }
      let committed;
      try {
        this.setData({ message: "正在将补充照片直传到私有存储，请勿关闭页面…", error: false });
        await this.uploadExtraPhotoDirect(begin.originalUpload, buffer);
        this.setData({ message: "上传完成，正在校验完整性并绑定工单…", error: false });
        committed = await this.callPhotoWithTransportRetry("commitVerificationPhotoUpload", {
          recordId: this.data.order.id, requestId: uploadRequestId
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
      this.setData({
        message: `${PHOTO_LABELS[slot]}已保存${normalized.converted ? "（已安全转换为 JPEG）" : ""}，正在重新读取数据库照片清单。`,
        error: false
      });
      await this.clearOriginalPhotoCache(slot);
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

  canvasNode() {
    return new Promise((resolve, reject) => this.createSelectorQuery().select("#receiptCanvas").fields({ node: true, size: true }).exec((items) => {
      if (!items || !items[0] || !items[0].node) reject(new Error("导出画布尚未准备完成"));
      else resolve(items[0].node);
    }));
  },

  async renderSharedReceipt(template, paginate = false, ratingQrSource = "") {
    const canvas = await this.canvasNode();
    const documentData = receiptDocumentData(this.data.order, this.data.baseType, template, ratingQrSource);
    const receipt = await renderReceiptCanvas({
      canvas,
      documentData,
      photos: [],
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
      let ratingQrSource = "";
      const ratingExport = ["store", "hq"].includes(clean(this.data.session?.role).toLowerCase())
        && this.data.baseType === "VERIFICATION"
        && ["NORMAL", "EXPERIENCE"].includes(clean(this.data.order?.originalType).toUpperCase());
      if (ratingExport && !this.data.rating.submitted) {
        this.setData({ exportProgress: "正在生成客户评价二维码…" });
        const issued = await callRating("issueForReceipt", { verificationId: clean(this.data.order.id) });
        if (issued.alreadySubmitted) {
          await this.loadRating();
        } else {
          ratingQrSource = clean(issued.qrDataUrl);
          if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/i.test(ratingQrSource)) {
            throw new Error("评价服务没有返回有效二维码，本次没有生成文件");
          }
        }
      }
      const template = await this.loadReceiptTemplate();
      this.setData({ exportProgress: "正在生成业务凭证…" });
      const receipt = await this.renderSharedReceipt(template, format === "pdf", ratingQrSource);
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

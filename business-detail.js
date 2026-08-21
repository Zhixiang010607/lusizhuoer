(() => {
  "use strict";

  const VERSION = "0.16.22";
  const PRODUCT_LOGO_DETAIL_RETRY_DELAYS_MS = Object.freeze([0, 360, 1080]);
  const type = document.body.dataset.recordDetail;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  let photoServiceApp = null;
  let verificationPhotoRequest = 0;
  let currentRecord = null;
  let currentVerificationPhotoPayload = null;
  let verificationPhotoLoadPromise = Promise.resolve();
  let verificationPhotoUploadBusy = false;
  let verificationPhotoUploadTask = null;
  let verificationPhotoRetryCandidate = null;
  let verificationPhotoTaskSequence = 0;
  let verificationPhotoSuccessDismissTimer = 0;
  const verificationPhotoLocalPreviews = new Map();
  let verificationCameraStream = null;
  let verificationCameraTarget = null;
  let verificationCameraFacingMode = "environment";
  let verificationCameraSwitchBusy = false;
  let verificationCameraRequest = 0;
  let verificationPhotoViewerRequest = 0;
  let verificationPhotoViewerFallbackUrl = "";
  let verificationPhotoViewerScale = 1;
  let verificationPhotoViewerTranslateX = 0;
  let verificationPhotoViewerTranslateY = 0;
  let verificationPhotoViewerPinch = null;
  const verificationPhotoPreloads = new Map();
  const verificationPhotoViewerPointers = new Map();
  const verificationPhotoOriginalAuditCache = new Set();
  const verificationExportBlobCache = new Map();
  const verificationPhotoReadFlights = new Map();
  const verificationPhotoBlobFlights = new Map();
  const verificationPhotoThumbnailFallbacks = new Map();
  let verificationExportDirectFetchUnavailable = false;
  let orderExportBusy = false;
  let currentProductTemplate = null;
  let currentProductTemplateError = null;
  let productTemplateLoadPromise = Promise.resolve();
  let productTemplateRequest = 0;
  let productReceiptLogoObjectUrl = "";

  function loadSessionRows(key) {
    try {
      const rows = JSON.parse(sessionStorage.getItem(key) || "[]");
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); }
    catch (_) { return null; }
  }

  function clean(value) {
    const text = String(value ?? "").trim();
    return text && text !== "undefined" && text !== "null" ? text : "";
  }

  function first(...values) {
    return values.map(clean).find(Boolean) || "";
  }

  function configureBackLink() {
    const link = document.querySelector(".back-link");
    if (!link) return;
    const session = readSession();
    const source = clean(params.get("source")).toLowerCase();
    if (source === "teacher" && session?.role === "teacher") {
      link.href = "teacher-work-orders.html";
      link.textContent = "← 返回我的工作台";
      return;
    }
    if (source === "review" && session?.role === "hq") {
      link.href = type === "recharge" ? "recharge-review.html" : "verification-review.html";
      link.textContent = type === "recharge" ? "← 返回充值审核" : "← 返回核销审核";
      return;
    }
    if (source !== "customer") return;
    const customerCode = clean(params.get("customerId"));
    const reviewRecordType = clean(params.get("reviewRecordType")).toUpperCase();
    const reviewRecordId = clean(params.get("reviewRecordId"));
    if (!customerCode || !["RECHARGE", "VERIFICATION"].includes(reviewRecordType) || !/^\d+$/.test(reviewRecordId)) return;
    const customerParams = new URLSearchParams({
      customerId: customerCode,
      source: "review",
      reviewRecordType,
      reviewRecordId
    });
    link.href = `customer-detail.html?${customerParams.toString()}`;
    link.textContent = "← 返回客户主页";
  }

  function field(row, snake, camel) {
    return row?.[snake] ?? row?.[camel] ?? "";
  }

  function normalizeDatabaseOrder(row) {
    if (!row) return null;
    const originalType = clean(field(row, "original_type", "originalType")).toUpperCase();
    const voidStatusValue = clean(field(row, "void_request_status", "voidRequestStatus")).toUpperCase();
    const originalKind = type === "recharge"
      ? ({ NEW: "充值申请", REFUND: "退费申请", VOID: "历史作废" }[originalType] || originalType || "充值")
      : ({ NORMAL: "正常核销", SUPPLEMENT: "补录核销", EXPERIENCE: "体验核销" }[originalType] || originalType || "核销");
    return {
      id: clean(row.id),
      recordCode: field(row, "record_code", "recordCode"),
      originalType,
      originalKind,
      status: field(row, "original_status", "originalStatus"),
      recordStatus: field(row, "original_status", "originalStatus"),
      voidStatus: voidStatusValue && voidStatusValue !== "NONE" ? field(row, "application_status", "applicationStatus") : "",
      voidSubmittedAt: voidStatusValue && voidStatusValue !== "NONE" ? field(row, "void_requested_at", "voidRequestedAt") : "",
      voidStoreNote: field(row, "void_request_note", "voidRequestNote"),
      voidReviewNote: field(row, "void_review_note", "voidReviewNote"),
      voidReviewedAt: field(row, "void_reviewed_at", "voidReviewedAt"),
      storeId: field(row, "store_id", "storeId"),
      storeCode: field(row, "store_code", "storeCode"),
      storeName: field(row, "store_name", "storeName"),
      storeProvince: field(row, "store_province", "storeProvince"),
      storeCity: field(row, "store_city", "storeCity"),
      storeDistrict: field(row, "store_district", "storeDistrict"),
      storeAddressDetail: field(row, "store_address_detail", "storeAddressDetail"),
      storeAddress: field(row, "store_address", "storeAddress"),
      customerId: field(row, "customer_id", "customerId"),
      customerCode: field(row, "customer_code", "customerCode"),
      customerName: field(row, "customer_name", "customerName"),
      projectId: field(row, "product_id", "productId"),
      projectCode: field(row, "product_code", "productCode"),
      projectName: field(row, "product_name", "productName"),
      teacherId: field(row, "teacher_id", "teacherId"),
      teacherCode: field(row, "teacher_code", "teacherCode"),
      teacherName: field(row, "teacher_name", "teacherName"),
      count: field(row, "unit_count", "unitCount"),
      balanceBeforeCount: field(row, "balance_before_count", "balanceBeforeCount"),
      balanceAfterCount: field(row, "balance_after_count", "balanceAfterCount"),
      createdAt: field(row, "original_submitted_at", "originalSubmittedAt"),
      reviewedAt: field(row, "original_reviewed_at", "originalReviewedAt"),
      initialStoreNote: field(row, "initial_store_note", "initialStoreNote"),
      supplementNote: field(row, "supplement_note", "supplementNote"),
      initialHqNote: field(row, "initial_review_note", "initialReviewNote"),
      reviewNote: field(row, "initial_review_note", "initialReviewNote"),
      databaseBacked: true
    };
  }

  function normalizeTeacherOrder(row) {
    if (!row) return null;
    const originalType = clean(row.originalType).toUpperCase();
    const voidRequestStatus = clean(row.voidRequestStatus).toUpperCase() || "NONE";
    const originalKind = type === "recharge"
      ? ({ NEW: "充值申请", REFUND: "退费申请", VOID: "历史作废" }[originalType] || originalType || "充值")
      : ({ NORMAL: "正常核销", SUPPLEMENT: "补录核销", EXPERIENCE: "体验核销" }[originalType] || originalType || "核销");
    return {
      id: clean(row.id),
      recordCode: clean(row.recordCode),
      originalType,
      originalKind,
      status: clean(row.recordStatus),
      recordStatus: clean(row.recordStatus),
      voidStatus: voidRequestStatus === "NONE" ? "" : voidRequestStatus,
      voidRequestStatus,
      storeId: clean(row.storeId),
      storeCode: clean(row.storeCode),
      storeName: clean(row.storeName),
      storeProvince: clean(row.storeProvince),
      storeCity: clean(row.storeCity),
      storeDistrict: clean(row.storeDistrict),
      storeAddressDetail: clean(row.storeAddressDetail),
      storeAddress: clean(row.storeAddress),
      customerCode: clean(row.customerCode),
      customerName: clean(row.customerName),
      projectCode: clean(row.productCode),
      projectName: clean(row.productName),
      teacherCode: clean(row.teacherCode),
      teacherName: clean(row.teacherName),
      count: row.unitCount,
      balanceBeforeCount: row.balanceBeforeCount,
      balanceAfterCount: row.balanceAfterCount,
      createdAt: row.submittedAt,
      reviewedAt: row.reviewedAt,
      initialStoreNote: clean(row.message),
      supplementNote: clean(row.supplementNote),
      initialHqNote: clean(row.reviewNote),
      reviewNote: clean(row.reviewNote),
      databaseBacked: true
    };
  }

  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function cloudFunctionPayload(result) {
    return [result?.result, result?.data?.result, result?.data, result]
      .map(parsedObject)
      .find((candidate) => candidate && (Object.prototype.hasOwnProperty.call(candidate, "ok") || Object.prototype.hasOwnProperty.call(candidate, "code"))) || {};
  }

  function registerCloudBaseComponent(register, componentName) {
    if (typeof register !== "function") return;
    try { register(window.cloudbase); }
    catch (error) {
      const detail = String(error?.message || error || "").toLowerCase();
      if (!(detail.includes("duplicate component") && detail.includes(componentName))) throw error;
    }
  }

  async function callVerificationPhoto(data) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
      throw new Error("核销照片服务未加载，请刷新页面重试");
    }
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    photoServiceApp ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    let raw;
    try {
      raw = await photoServiceApp.callFunction({ name: "verificationPhoto", data });
    } catch (error) {
      const diagnostic = [error?.code, error?.requestId || error?.RequestId].filter(Boolean).join(" · ");
      const wrapped = new Error(`${error?.message || "核销照片云函数调用失败"}${diagnostic ? `（${diagnostic}）` : ""}`);
      wrapped.code = clean(error?.code) || "PHOTO_SERVICE_CALL_FAILED";
      wrapped.requestId = clean(error?.requestId || error?.RequestId);
      wrapped.cause = error;
      throw wrapped;
    }
    const payload = cloudFunctionPayload(raw);
    if (!payload?.ok) {
      const error = new Error(payload?.message || "核销照片服务没有返回业务结果");
      error.code = payload?.code || "PHOTO_SERVICE_FAILED";
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function verificationPhotoReadFlightKey(data) {
    return [clean(data?.action), clean(data?.recordId), Number(data?.slot ?? -1)].join(":");
  }

  function coalesceVerificationPhotoTask(store, key, createTask) {
    const existing = store.get(key);
    if (existing) return existing;
    let task = null;
    task = Promise.resolve().then(createTask).finally(() => {
      if (store.get(key) === task) store.delete(key);
    });
    store.set(key, task);
    return task;
  }

  function verificationPhotoReadCanRetry(error) {
    const code = clean(error?.code).toUpperCase();
    const terminalCodes = new Set([
      "PHOTO_NOT_FOUND", "PHOTO_SLOT_INVALID", "PHOTO_EXPORT_TOO_LARGE",
      "FORBIDDEN", "UNAUTHORIZED", "UNAUTHENTICATED", "ARCHIVED", "BAD_REQUEST",
      "PHOTO_STORAGE_MISCONFIGURED", "PHOTO_BUCKET_CONFIG_INVALID", "VERIFICATION_PHOTO_FUNCTION_DISABLED"
    ]);
    if (terminalCodes.has(code)) return false;
    const status = Number(error?.httpStatus || error?.status || 0);
    if (status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) return false;
    return true;
  }

  function callVerificationPhotoReadAttempt(data) {
    // callFunction already owns the provider timeout. A second client-side race cannot cancel
    // the underlying request and would amplify one slow read into overlapping retries.
    return callVerificationPhoto(data);
  }

  function callVerificationPhotoRead(data, attempts = 3) {
    const key = verificationPhotoReadFlightKey(data);
    return coalesceVerificationPhotoTask(verificationPhotoReadFlights, key, async () => {
      let lastError = null;
      const limit = Math.max(1, Number(attempts) || 1);
      for (let attempt = 1; attempt <= limit; attempt += 1) {
        try {
          return await callVerificationPhotoReadAttempt(data);
        } catch (error) {
          lastError = error;
          if (attempt >= limit || !verificationPhotoReadCanRetry(error)) break;
          await waitForVerificationPhotoRetry(180 * attempt + Math.floor(Math.random() * 91));
        }
      }
      throw lastError || new Error("核销照片读取失败");
    });
  }

  function callVerificationPhotoLifecycle(data, timeoutMs = 8000) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(verificationPhotoUploadError("网络响应较慢，请再次确认上传状态", "PHOTO_UPLOAD_CONFIRM_TIMEOUT")), timeoutMs);
    });
    return Promise.race([callVerificationPhoto(data), timeout]).finally(() => clearTimeout(timer));
  }

  async function loadTeacherOrder(recordId) {
    if (!/^\d+$/.test(recordId)) throw new Error("老师工单必须使用数据库编号读取");
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("工单数据服务未加载，请刷新页面重试");
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    const raw = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({
      name: "faceRecognition",
      data: { action: "getTeacherWorkspace", recordType: type.toUpperCase(), recordId }
    });
    const payload = cloudFunctionPayload(raw);
    if (!payload.ok || !payload.record) throw new Error(payload.message || "未找到当前老师本人绑定的工单");
    return normalizeTeacherOrder(payload.record);
  }

  function formatTime(value) {
    return window.AppDateTime.format(value, "");
  }

  function exportButtons() {
    return [$("exportOrderPdf"), $("exportOrderImage")].filter(Boolean);
  }

  function setExportControls(enabled, message = "") {
    exportButtons().forEach((button) => { button.disabled = !enabled || orderExportBusy; });
    const status = $("orderExportMessage");
    if (status && message !== undefined) status.textContent = message;
  }

  function elementText(element, selector) {
    return clean(element?.querySelector(selector)?.textContent);
  }

  function exportDocumentData(record, loadedTemplate = currentProductTemplate) {
    const recharge = type === "recharge";
    const refund = recharge && first(record.originalType, record.rechargeType).toUpperCase() === "REFUND";
    const facts = Array.from($("orderKeyfacts")?.children || []).map((element) => ({
      label: elementText(element, "span"),
      value: elementText(element, "strong")
    }));
    const details = Array.from($("orderInfo")?.children || []).map((element) => ({
      label: elementText(element, "span"),
      value: elementText(element, "strong")
    }));
    const verificationFacts = facts.filter((item) => ["门店", "客户", "项目", "业务老师"].includes(item.label));
    const submittedAt = details.find((item) => item.label === "提交时间")?.value
      || facts.find((item) => item.label === "提交时间")?.value
      || "—";
    const messages = [];
    const customerName = first(record.customerName, record.customerCode, "客户");
    const projectName = first(record.projectName, record.productName, record.projectCode, record.productCode, "项目");
    const template = loadedTemplate || {};
    return {
      filename: `${customerName}+${projectName}+${refund ? "退费" : recharge ? "充值" : "核销"}`,
      kind: clean($("orderKindTag")?.textContent) || (recharge ? "充值" : "核销"),
      title: clean($("orderTitle")?.textContent) || `${recharge ? "充值" : "核销"}工单`,
      subtitle: recharge
        ? (clean($("orderDescription")?.textContent) || "业务工单完整导出")
        : `${clean($("orderDescription")?.textContent) || "门店详细地址：未填写"} · 提交时间：${submittedAt}`,
      facts: recharge ? facts : verificationFacts,
      customerFacing: true,
      compactVerification: !recharge,
      detailTitle: refund ? "退费信息" : recharge ? "充值信息" : "核销信息",
      detailSubtitle: refund ? "退费次数与办理时间" : recharge ? "充值次数与办理时间" : "该工单数据库中保存的完整业务内容",
      details: recharge ? details : [],
      messages,
      productTemplate: {
        productName: first(template.productName, record.projectName, record.productName, "产品"),
        productType: first(template.productType, "未分类"),
        instructions: recharge ? clean(template.rechargeInstructions) : clean(template.verificationInstructions),
        logoRequired: Boolean(template.logo),
        logoBlob: template.logoBlob instanceof Blob ? template.logoBlob : null
      }
    };
  }

  function productReference(record) {
    return first(
      record?.projectId, record?.productId, record?.projectCode, record?.productCode,
      record?.project?.id, record?.product?.id, record?.project?.code, record?.product?.code
    );
  }

  function assertProductReceiptTemplate(template, record, requestedRef) {
    if (!template || typeof template !== "object") throw new Error("产品单据模板不存在");
    const recordIdOrCode = first(record?.projectId, record?.productId, record?.project?.id, record?.product?.id);
    const expectedId = /^\d+$/.test(recordIdOrCode) ? recordIdOrCode : "";
    const expectedCode = first(
      record?.projectCode, record?.productCode, record?.project?.code, record?.product?.code,
      expectedId ? "" : recordIdOrCode
    ).toUpperCase();
    const actualId = clean(template?.id);
    const actualCode = clean(template?.productCode).toUpperCase();
    const requested = clean(requestedRef);
    const requestedMatches = /^\d+$/.test(requested)
      ? Boolean(actualId && requested === actualId)
      : Boolean(actualCode && requested.toUpperCase() === actualCode);
    if (!requestedMatches
        || (expectedId && (!actualId || expectedId !== actualId))
        || (expectedCode && (!actualCode || expectedCode !== actualCode))) {
      throw new Error(`工单产品模板不一致（请求 ${requested || "—"}，返回 ${actualCode || actualId || "无编号"}）`);
    }
    const instructions = type === "recharge"
      ? clean(template?.rechargeInstructions)
      : clean(template?.verificationInstructions);
    if (!instructions) {
      const productName = first(record?.projectName, record?.productName, template?.productName, "该产品");
      const productCode = first(record?.projectCode, record?.productCode, template?.productCode);
      const receiptKind = type === "recharge" ? "充值／退费" : "核销／体验核销";
      throw new Error(`${productName}${productCode ? `（${productCode}）` : ""}尚未配置${receiptKind}单据说明，请总部先打开该产品模板保存说明`);
    }
    return template;
  }

  function base64ImageBlob(payload) {
    const base64 = clean(payload?.base64);
    const mimeType = clean(payload?.mimeType);
    if (!base64 || !mimeType.startsWith("image/")) throw new Error("产品 LOGO 原图数据无效");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (!bytes.length || (Number(payload?.bytes || bytes.length) !== bytes.length)) throw new Error("产品 LOGO 原图数据不完整");
    return new Blob([bytes], { type: mimeType });
  }

  async function fetchProductLogoBlob(template, productRef, { forceRefresh = false } = {}) {
    if (!template?.logo) return null;
    if (template.logo.url && !forceRefresh) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeout = window.setTimeout(() => controller?.abort(), 12000);
      try {
        const response = await fetch(template.logo.url, {
          method: "GET", mode: "cors", credentials: "omit", cache: "force-cache",
          referrerPolicy: "no-referrer", signal: controller?.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size || !String(blob.type || "").startsWith("image/")) throw new Error("返回内容不是图片");
        if (Number(template.logo.bytes || 0) && blob.size !== Number(template.logo.bytes)) throw new Error("原图大小不一致");
        return blob;
      } catch (_) { /* use the authenticated original-byte fallback below */ }
      finally { window.clearTimeout(timeout); }
    }
    if (!window.CloudBasePhoneAuth?.getProductReceiptLogoData) throw new Error("产品 LOGO 原图读取失败");
    return base64ImageBlob(await window.CloudBasePhoneAuth.getProductReceiptLogoData({
      productRef,
      expectedReference: clean(template.logo.reference),
      forceRefresh
    }));
  }

  function waitForProductLogoRetry(milliseconds) {
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(milliseconds / 4)));
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds + jitter));
  }

  function clearProductReceiptLogoObjectUrl() {
    if (!productReceiptLogoObjectUrl) return;
    URL.revokeObjectURL(productReceiptLogoObjectUrl);
    productReceiptLogoObjectUrl = "";
  }

  function renderProductReceiptBrand(template, record) {
    const panel = $("productReceiptBrand");
    if (!panel) return;
    const instructions = type === "recharge"
      ? clean(template?.rechargeInstructions)
      : clean(template?.verificationInstructions);
    clearProductReceiptLogoObjectUrl();
    const logoBlob = template?.logoBlob instanceof Blob && template.logoBlob.size
      ? template.logoBlob
      : null;
    if (logoBlob) productReceiptLogoObjectUrl = URL.createObjectURL(logoBlob);
    // The private signed URL has already been downloaded and verified above.
    // Render the in-memory Blob so an expiring URL cannot break the visible
    // LOGO after the rest of the order detail has finished loading.
    const logoUrl = productReceiptLogoObjectUrl;
    panel.hidden = false;
    panel.innerHTML = `<div class="order-product-logo">${logoUrl
      ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(first(template.productName, record.projectName, "产品"))} LOGO">`
      : "<span>LOGO</span>"}</div><div class="order-product-copy"><span>产品单据</span><strong>${escapeHtml(first(template?.productName, record.projectName, record.productName, "产品"))}</strong><small>${escapeHtml(first(template?.productType, "未分类"))}</small><p>${escapeHtml(instructions || "暂无产品说明")}</p></div>`;
  }

  async function loadProductReceiptTemplate(record, { forceLogoRefresh = false } = {}) {
    const request = ++productTemplateRequest;
    const productRef = productReference(record);
    let template = null;
    try {
      if (!productRef) throw new Error("当前工单缺少产品编号，不能生成产品单据");
      if (!window.CloudBasePhoneAuth?.getProductReceiptTemplate) {
        throw new Error("产品单据模板服务尚未加载，请刷新页面重试");
      }
      template = assertProductReceiptTemplate(
        await window.CloudBasePhoneAuth.getProductReceiptTemplate({ productRef, forceRefresh: forceLogoRefresh }),
        record,
        productRef
      );
      if (request === productTemplateRequest) {
        currentProductTemplate = template;
        currentProductTemplateError = null;
        renderProductReceiptBrand(template, record);
      }
    } catch (error) {
      if (request === productTemplateRequest) {
        currentProductTemplate = null;
        currentProductTemplateError = error;
        renderProductReceiptBrand({}, record);
      }
      throw error;
    }

    if (!template.logo || request !== productTemplateRequest) return template;
    let lastLogoError = null;
    for (let attempt = 0; attempt < PRODUCT_LOGO_DETAIL_RETRY_DELAYS_MS.length; attempt += 1) {
      if (request !== productTemplateRequest) return template;
      const delay = PRODUCT_LOGO_DETAIL_RETRY_DELAYS_MS[attempt];
      if (delay) await waitForProductLogoRetry(delay);
      if (request !== productTemplateRequest) return template;
      try {
        template.logoBlob = await fetchProductLogoBlob(template, productRef, {
          forceRefresh: forceLogoRefresh || attempt > 0
        });
        if (request === productTemplateRequest) {
          currentProductTemplate = template;
          currentProductTemplateError = null;
          renderProductReceiptBrand(template, record);
        }
        return template;
      } catch (error) {
        lastLogoError = error;
        if (clean(error?.code).toUpperCase() === "PRODUCT_LOGO_CHANGED") {
          template = assertProductReceiptTemplate(
            await window.CloudBasePhoneAuth.getProductReceiptTemplate({ productRef, forceRefresh: true }),
            record,
            productRef
          );
          if (!template.logo) {
            if (request === productTemplateRequest) {
              currentProductTemplate = template;
              currentProductTemplateError = null;
              renderProductReceiptBrand(template, record);
            }
            return template;
          }
        }
      }
    }
    if (request === productTemplateRequest) {
      // Keep the already-authorized template text visible. Only the private
      // LOGO remains unavailable, and the next export forces another live read.
      currentProductTemplate = template;
      currentProductTemplateError = lastLogoError;
      renderProductReceiptBrand(template, record);
    }
    throw lastLogoError || new Error("产品 LOGO 原图读取失败");
  }

  async function fetchVerificationPhotoUrlBlob(url, slot) {
    if (/^data:image\/jpeg;base64,/i.test(clean(url))) return verificationPhotoDataBlob(url, slot);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = window.setTimeout(() => controller?.abort(), 12000);
    try {
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller?.signal
      });
      if (!response.ok) {
        const error = new Error(`${photoSlotLabel(slot)}读取失败（HTTP ${response.status}）`);
        error.httpStatus = response.status;
        throw error;
      }
      const blob = await response.blob();
      if (!blob.size || !String(blob.type || "").toLowerCase().startsWith("image/")) {
        throw new Error(`${photoSlotLabel(slot)}没有返回有效图片`);
      }
      return blob;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`${photoSlotLabel(slot)}高清原图读取超时`);
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function verificationPhotoDataBlob(value, slot) {
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || "").trim());
    if (!match) throw new Error(`${photoSlotLabel(slot)}安全导出数据格式无效`);
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (!bytes.length || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error(`${photoSlotLabel(slot)}安全导出数据不是有效 JPEG`);
    }
    return new Blob([bytes], { type: "image/jpeg" });
  }

  function verificationExportCacheKey(recordId, photo) {
    return [clean(recordId), Number(photo?.slot), Number(photo?.originalBytes || 0), clean(photo?.uploadedAt)].join(":");
  }

  function verificationPhotoUrlNeverExpires(url) {
    return clean(url).startsWith("blob:") || /^data:image\/jpeg;base64,/i.test(clean(url));
  }

  function waitForVerificationPhotoRetry(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function fetchVerificationPhotoExportFallback(recordId, slot) {
    const payload = await callVerificationPhotoRead({ action: "getVerificationPhotoExportData", recordId, slot });
    return verificationPhotoDataBlob(payload.imageBase64, slot);
  }

  async function refreshVerificationPhotoOriginalUrl(recordId, slot, photo) {
    const payload = await callVerificationPhotoRead({ action: "getVerificationPhotoOriginalUrl", recordId, slot });
    if (!clean(payload?.photoUrl)) {
      const error = new Error(`${photoSlotLabel(slot)}临时访问地址无效`);
      error.code = "PHOTO_SIGN_FAILED";
      throw error;
    }
    if (photo && typeof photo === "object") {
      photo.originalUrl = payload.photoUrl;
      photo.originalUrlExpiresAt = verificationPhotoUrlNeverExpires(payload.photoUrl)
        ? Number.MAX_SAFE_INTEGER
        : Date.now() + Math.max(0, Number(payload.expiresIn || 0) * 1000);
    }
    return payload;
  }

  function fetchVerificationPhotoBlob(recordId, photo) {
    const slot = Number(photo.slot);
    const cacheKey = verificationExportCacheKey(recordId, photo);
    const cachedBlob = verificationExportBlobCache.get(cacheKey);
    if (cachedBlob instanceof Blob && cachedBlob.size) return cachedBlob;
    return coalesceVerificationPhotoTask(verificationPhotoBlobFlights, cacheKey, async () => {
      const cachedUrl = clean(photo?.originalUrl);
      const cachedUrlValid = cachedUrl && Number(photo?.originalUrlExpiresAt || 0) > Date.now() + 10000;
      if (cachedUrlValid && !verificationExportDirectFetchUnavailable) {
        try {
          const blob = await fetchVerificationPhotoUrlBlob(cachedUrl, slot);
          verificationExportBlobCache.set(cacheKey, blob);
          return blob;
        } catch (error) {
          if (error instanceof TypeError) verificationExportDirectFetchUnavailable = true;
          // A rejected or expired cached URL gets one newly authorized URL before binary fallback.
        }
      }
      if (!verificationExportDirectFetchUnavailable) {
        try {
          const payload = await refreshVerificationPhotoOriginalUrl(recordId, slot, photo);
          const blob = await fetchVerificationPhotoUrlBlob(payload.photoUrl, slot);
          verificationExportBlobCache.set(cacheKey, blob);
          return blob;
        } catch (error) {
          if (error instanceof TypeError) verificationExportDirectFetchUnavailable = true;
          // CORS and signed-download failures use the authenticated server-scoped fallback below.
        }
      }
      const blob = await fetchVerificationPhotoExportFallback(recordId, slot);
      verificationExportBlobCache.set(cacheKey, blob);
      return blob;
    });
  }

  async function assertVerificationPhotoOriginalBlob(blob, photo) {
    const slot = Number(photo?.slot);
    const expectedBytes = Number(photo?.originalBytes || 0);
    if (!(blob instanceof Blob) || !blob.size) throw new Error(`${photoSlotLabel(slot)}高清原图为空`);
    const signature = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    if (signature.length < 3 || signature[0] !== 0xff || signature[1] !== 0xd8 || signature[2] !== 0xff) {
      throw new Error(`${photoSlotLabel(slot)}高清原图不是有效 JPEG`);
    }
    if (expectedBytes > 0 && blob.size !== expectedBytes) {
      const error = new Error(`${photoSlotLabel(slot)}高清原图字节数不一致`);
      error.code = "PHOTO_ORIGINAL_BYTES_MISMATCH";
      throw error;
    }
    return blob;
  }

  async function fetchVerificationPhotoOriginalForDownload(recordId, photo) {
    const cacheKey = verificationExportCacheKey(recordId, photo);
    try {
      return await assertVerificationPhotoOriginalBlob(await fetchVerificationPhotoBlob(recordId, photo), photo);
    } catch (firstError) {
      verificationExportBlobCache.delete(cacheKey);
      verificationPhotoBlobFlights.delete(cacheKey);
      try {
        // Direct local downloads must never fall back to a thumbnail. This
        // authenticated response returns the exact stored original JPEG bytes.
        return await assertVerificationPhotoOriginalBlob(
          await fetchVerificationPhotoExportFallback(recordId, Number(photo?.slot)),
          photo
        );
      } catch (fallbackError) {
        const error = new Error(`${photoSlotLabel(Number(photo?.slot))}高清原图下载失败；未使用缩略图代替。${clean(fallbackError?.message || firstError?.message)}`);
        error.code = fallbackError?.code || firstError?.code || "PHOTO_ORIGINAL_DOWNLOAD_FAILED";
        throw error;
      }
    }
  }

  function verificationPhotoOriginalFilename(recordId, slot) {
    const recordCode = first(currentRecord?.recordCode, currentRecord?.code, recordId, "核销单");
    const raw = `${recordCode}-${photoSlotLabel(slot)}-高清原图`;
    const safe = typeof window.OrderExporter?.safeFilename === "function"
      ? window.OrderExporter.safeFilename(raw)
      : raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);
    return `${safe || "核销照片高清原图"}.jpg`;
  }

  async function saveVerificationPhotoOriginal(blob, filename) {
    let shareError = null;
    if (usesMobilePhotoLibrary()
      && typeof File === "function"
      && typeof navigator.share === "function"
      && typeof navigator.canShare === "function") {
      const originalFile = new File([blob], filename, {
        type: "image/jpeg",
        lastModified: Date.now()
      });
      const shareFiles = { files: [originalFile] };
      if (navigator.canShare(shareFiles)) {
        try {
          await navigator.share({
            ...shareFiles,
            title: "保存高清原图到相册"
          });
          return { mode: "album" };
        } catch (error) {
          if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
            const cancelled = new Error("已取消保存到相册。");
            cancelled.code = "PHOTO_ALBUM_SAVE_CANCELLED";
            throw cancelled;
          }
          shareError = error;
        }
      }
    }
    if (typeof window.OrderExporter?.downloadBlob !== "function") {
      throw shareError || new Error("本地下载组件未加载，请刷新页面重试");
    }
    // File sharing and the fallback download both receive the exact validated
    // original Blob. Never draw through canvas or replace it with a thumbnail.
    window.OrderExporter.downloadBlob(blob, filename);
    return { mode: "download", shareError };
  }

  async function downloadVerificationPhotoOriginal(recordId, photo, button) {
    if (!photo || button?.dataset.photoDownload === "running") return;
    const slot = Number(photo.slot);
    const previousLabel = button?.textContent || "下载高清原图";
    if (button) {
      button.dataset.photoDownload = "running";
      button.disabled = true;
      button.textContent = "原图读取中…";
    }
    const message = $("verificationPhotoMessage");
    if (message) {
      message.className = "verification-photo-message";
      message.textContent = `正在读取${photoSlotLabel(slot)}高清原图；不会转码或压缩…`;
    }
    try {
      const blob = await fetchVerificationPhotoOriginalForDownload(recordId, photo);
      const saved = await saveVerificationPhotoOriginal(blob, verificationPhotoOriginalFilename(recordId, slot));
      if (message) {
        message.textContent = saved.mode === "album"
          ? `${photoSlotLabel(slot)}高清原图已交给手机系统处理（${photoSizeLabel(blob.size)}，原始字节，无压缩）。`
          : `当前浏览器不能直接打开相册保存面板，已下载${photoSlotLabel(slot)}高清原图（${photoSizeLabel(blob.size)}，原始字节，无压缩）；请从“下载”中存入相册。`;
      }
    } catch (error) {
      if (message) {
        message.className = error?.code === "PHOTO_ALBUM_SAVE_CANCELLED"
          ? "verification-photo-message"
          : "verification-photo-message error";
        message.textContent = error?.message || `${photoSlotLabel(slot)}高清原图下载失败，请重试。`;
      }
    } finally {
      if (button) {
        delete button.dataset.photoDownload;
        button.disabled = false;
        button.textContent = previousLabel;
      }
    }
  }

  async function fetchVerificationPhotoForExport(recordId, photo, onStatus = () => {}) {
    const slot = Number(photo?.slot);
    const firstCacheKey = verificationExportCacheKey(recordId, photo);
    let originalError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const blob = await fetchVerificationPhotoBlob(recordId, photo);
        return { blob, usedThumbnail: false };
      } catch (error) {
        originalError = error;
        if (attempt >= 2 || !verificationPhotoReadCanRetry(error)) break;
        onStatus(`${photoSlotLabel(slot)}原图读取不稳定，正在单独重试…`);
        verificationExportBlobCache.delete(firstCacheKey);
        verificationPhotoBlobFlights.delete(firstCacheKey);
        try {
          const manifest = await fetchVerificationPhotoManifest(recordId);
          const refreshed = manifest.photos.find((candidate) => Number(candidate?.slot) === slot);
          if (refreshed) {
            Object.assign(photo, refreshed);
            photo.originalUrlExpiresAt = verificationPhotoUrlNeverExpires(photo.originalUrl)
              ? Number.MAX_SAFE_INTEGER
              : Date.now() + Math.max(0, Number(photo?.originalUrlExpiresIn ?? manifest?.expiresIn ?? 0) * 1000);
          }
        } catch (_) { /* 下一次读取仍会走服务端安全通道 */ }
        verificationExportBlobCache.delete(verificationExportCacheKey(recordId, photo));
        verificationPhotoBlobFlights.delete(verificationExportCacheKey(recordId, photo));
        await waitForVerificationPhotoRetry(240);
      }
    }
    onStatus(`${photoSlotLabel(slot)}高清原图暂不可用，正在读取安全缩略图备份…`);
    try {
      const blob = await fetchVerificationPhotoThumbnailFallback(recordId, slot);
      return { blob, usedThumbnail: true };
    } catch (thumbnailError) {
      const error = new Error(`${photoSlotLabel(slot)}原图和预览图都无法读取。${clean(originalError?.message || thumbnailError?.message)}`);
      error.code = originalError?.code || thumbnailError?.code || "PHOTO_EXPORT_UNAVAILABLE";
      throw error;
    }
  }

  function exportPhotoFailureMeta(error) {
    const code = clean(error?.code).toUpperCase();
    const message = clean(error?.message);
    if (code === "PHOTO_NOT_FOUND" || message.includes("尚未上传") || message.includes("不存在")) return "照片文件未找到";
    if (code === "PHOTO_SIGN_FAILED" || message.includes("临时访问地址")) return "已保存 · 临时访问地址生成失败";
    if (message.includes("HTTP") || message.includes("下载")) return "已保存 · 照片下载失败";
    return "已保存 · 导出时暂无法读取原图";
  }

  function verificationPhotoManifestSignature(payload) {
    return (Array.isArray(payload?.photos) ? payload.photos : [])
      .map((photo) => [Number(photo?.slot), Number(photo?.originalBytes || 0), clean(photo?.uploadedAt)].join(":"))
      .sort()
      .join("|");
  }

  async function fetchVerificationPhotoManifest(recordId) {
    const payload = await callVerificationPhotoRead({ action: "getVerificationPhotos", recordId });
    if (payload?.ok !== true || !Array.isArray(payload?.photos)) {
      throw new Error("核销照片清单返回格式无效");
    }
    return payload;
  }

  async function verificationExportPhotos(record) {
    await verificationPhotoLoadPromise;
    if (verificationPhotoUploadBusy) throw new Error("照片仍在上传，请等待保存完成后再导出。");
    const recordId = clean(record?.id);
    const databaseBacked = record?.databaseBacked === true && /^\d+$/.test(recordId);
    let manifest = currentVerificationPhotoPayload;
    if (databaseBacked) {
      setExportControls(false, "正在核对数据库中的最新照片清单…");
      try {
        manifest = mergeVerificationPhotoLocalPreviews(
          await fetchVerificationPhotoManifest(recordId),
          recordId
        );
        renderVerificationPhotos(manifest, recordId);
      } catch (error) {
        throw new Error(`核销照片清单暂时无法确认，本次没有生成文件。${clean(error?.message) || "请刷新页面后重试。"}`);
      }
    } else if (!manifest) {
      manifest = { ok: true, photos: [], error: null };
    }
    const listError = manifest?.error || null;
    if (listError || !Array.isArray(manifest?.photos)) {
      throw new Error("核销照片清单暂时无法确认，本次没有生成文件。请刷新页面后重试。");
    }
    const manifestSignature = verificationPhotoManifestSignature(manifest);
    const available = new Map(manifest.photos.map((photo) => [Number(photo.slot), photo]));
    const output = Array.from({ length: 5 }, (_, slot) => ({
      slot,
      label: photoSlotLabel(slot),
      required: available.has(slot),
      meta: available.has(slot) ? "正在读取高清原图" : "空照片位",
      placeholder: available.has(slot) ? "照片读取中" : "尚未上传",
      blob: null
    }));
    const queue = Array.from(available.values()).filter((photo) => Number.isInteger(Number(photo.slot)) && Number(photo.slot) >= 0 && Number(photo.slot) <= 4);
    let cursor = 0;
    let succeeded = 0;
    const failures = [];
    const thumbnailFallbacks = [];
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (cursor < queue.length) {
        const index = cursor;
        cursor += 1;
        const photo = queue[index];
        const slot = Number(photo.slot);
        try {
          const fetched = await fetchVerificationPhotoForExport(recordId, photo, (message) => setExportControls(false, message));
          const blob = fetched.blob;
          output[slot] = {
            slot,
            label: photoSlotLabel(slot),
            required: true,
            meta: [fetched.usedThumbnail ? "安全缩略图备份" : "高清原图", photoSizeLabel(blob.size), formatTime(photo.uploadedAt) || "已保存"].filter(Boolean).join(" · "),
            placeholder: "照片读取失败",
            blob
          };
          if (fetched.usedThumbnail) thumbnailFallbacks.push(slot);
          succeeded += 1;
        } catch (error) {
          failures.push({ slot, message: exportPhotoFailureMeta(error) });
        } finally {
          setExportControls(false, `核销照片成功读取 ${succeeded} / ${queue.length}…`);
        }
      }
    });
    await Promise.all(workers);
    if (failures.length) {
      const labels = failures.sort((left, right) => left.slot - right.slot)
        .map((failure) => `${photoSlotLabel(failure.slot)}（${failure.message}）`).join("、");
      throw new Error(`${labels}未能完整载入，本次没有生成文件。请检查网络后重试。`);
    }
    const requiredCount = output.filter((photo) => photo.required).length;
    const loadedCount = output.filter((photo) => photo.required && photo.blob instanceof Blob && photo.blob.size).length;
    if (loadedCount !== requiredCount) throw new Error("核销照片完整性检查未通过，本次没有生成文件。请重试。");
    const editableUntil = Date.parse(manifest?.editableUntil || "");
    if (databaseBacked && Number.isFinite(editableUntil) && editableUntil > Date.now()) {
      setExportControls(false, "正在确认照片清单没有在导出期间发生变化…");
      let confirmedManifest;
      try { confirmedManifest = await fetchVerificationPhotoManifest(recordId); }
      catch (error) {
        throw new Error(`核销照片最终确认失败，本次没有生成文件。${clean(error?.message) || "请重试。"}`);
      }
      if (verificationPhotoManifestSignature(confirmedManifest) !== manifestSignature) {
        renderVerificationPhotos(confirmedManifest, recordId);
        throw new Error("核销照片在导出期间发生了变化，本次没有生成文件。请重新导出以包含最新照片。");
      }
    }
    const warning = thumbnailFallbacks.length
      ? `${thumbnailFallbacks.sort((left, right) => left - right).map(photoSlotLabel).join("、")}的高清原图地址暂不可用，已自动使用安全缩略图完成导出`
      : "";
    return { photos: output, warning };
  }

  async function exportCurrentOrder(format) {
    if (orderExportBusy || !currentRecord) return;
    if (type === "verification" && verificationPhotoUploadBusy) {
      setExportControls(false, "照片正在上传，请等待保存完成后再导出。");
      return;
    }
    if (!window.OrderExporter?.exportOrder) {
      setExportControls(true, "导出组件未加载，请刷新页面重试。");
      return;
    }
    orderExportBusy = true;
    setExportControls(false, type === "verification" ? "正在准备工单与照片…" : "正在生成客户业务凭证…");
    try {
      // A product template can be edited in another tab after this detail page
      // opened. Always re-read it at the action boundary so the downloaded
      // customer file never contains a stale or silently empty template.
      productTemplateLoadPromise = loadProductReceiptTemplate(currentRecord, { forceLogoRefresh: true });
      let exportTemplate;
      try { exportTemplate = await productTemplateLoadPromise; }
      catch (error) { throw new Error(`产品单据模板读取失败，本次没有生成文件。${clean(error?.message) || "请重试。"}`); }
      const photoResult = type === "verification" ? await verificationExportPhotos(currentRecord) : { photos: [], warning: "" };
      setExportControls(false, format === "pdf" ? "正在分页生成 PDF…" : "正在生成高清图片…");
      const result = await window.OrderExporter.exportOrder({
        format,
        documentData: exportDocumentData(currentRecord, exportTemplate),
        photos: photoResult.photos
      });
      setExportControls(false, `已生成：${result.filename}${photoResult.warning ? `（${photoResult.warning}）` : ""}`);
    } catch (error) {
      setExportControls(false, error?.message || "工单导出失败，请重试。");
    } finally {
      orderExportBusy = false;
      setExportControls(Boolean(currentRecord), $("orderExportMessage")?.textContent || "");
    }
  }

  function isVoidableOriginalType(record) {
    const originalType = first(record?.originalType, record?.rechargeType, record?.verificationType).toUpperCase();
    return type === "recharge" && originalType === "NEW";
  }

  function hasVoidLifecycle(record) {
    const voidRequestStatus = first(record?.voidStatus, record?.voidRequestStatus).toUpperCase();
    return Boolean(
      record?.voidSubmittedAt ||
      record?.voidStoreNote ||
      (voidRequestStatus && voidRequestStatus !== "NONE")
    );
  }

  function canStoreRequestVoid(record, storeMode, voidStarted = hasVoidLifecycle(record)) {
    const originalStatus = first(record?.status, record?.recordStatus).toUpperCase();
    return Boolean(
      type === "recharge" &&
      storeMode &&
      !voidStarted &&
      record?.databaseBacked === true &&
      originalStatus === "APPROVED" &&
      isVoidableOriginalType(record)
    );
  }

  function statusView(value) {
    const code = first(value, "PENDING").toUpperCase();
    if (["APPROVED", "ACTIVE", "COMPLETED"].includes(code)) return { label: "审核通过", className: "approved", hint: "审核已完成" };
    if (code === "VOIDED") return { label: "已作废", className: "rejected", hint: "历史工单状态为已作废" };
    if (["REJECTED", "ARCHIVED", "CANCELLED"].includes(code)) return { label: "已驳回", className: "rejected", hint: "该工单已被驳回" };
    return { label: "待审核", className: "pending", hint: "等待总部审核处理" };
  }

  function labelParts(name, code, emptyLabel = "—") {
    const safeName = clean(name);
    const safeCode = clean(code);
    if (!safeName && !safeCode) return { name: emptyLabel, code: "" };
    return { name: safeName || safeCode, code: safeName && safeCode && safeName !== safeCode ? safeCode : "" };
  }

  function factCard(label, name, code, emptyLabel = "—") {
    const parts = labelParts(name, code, emptyLabel);
    return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(parts.name)}${parts.code ? ` <em>· ${escapeHtml(parts.code)}</em>` : ""}</strong></div>`;
  }

  function fullStoreAddress(record) {
    const explicit = first(record?.storeAddress, record?.storeFullAddress);
    if (explicit) return explicit;
    return [record?.storeProvince, record?.storeCity, record?.storeDistrict, record?.storeAddressDetail]
      .map(clean)
      .filter(Boolean)
      .join("");
  }

  function infoCard(label, value, className = "") {
    const text = clean(value);
    const emptyLabel = `暂无${label}`;
    return `<article${className ? ` class="${className}"` : ""}><span>${escapeHtml(label)}</span><strong${text ? "" : ` aria-label="${escapeHtml(emptyLabel)}"`}>${text ? escapeHtml(text) : "&nbsp;"}</strong></article>`;
  }

  function findRecord(recordId) {
    const key = type === "recharge" ? "prototypeRechargeRecords" : "prototypeVerificationRecords";
    return loadSessionRows(key).find((row) => (
      String(row?.id || "") === recordId || String(row?.recordCode || "") === recordId
    )) || null;
  }

  function recordKey() {
    return type === "recharge" ? "prototypeRechargeRecords" : "prototypeVerificationRecords";
  }

  function saveRecord(record) {
    const rows = loadSessionRows(recordKey());
    const index = rows.findIndex((row) => String(row?.id || row?.recordCode || "") === String(record.id));
    if (index >= 0) rows[index] = record;
    else rows.unshift(record);
    try { sessionStorage.setItem(recordKey(), JSON.stringify(rows)); } catch (_) { /* 静态原型 */ }
  }

  function commentCard(title, message, time) {
    const text = clean(message);
    return `<article class="order-comment-card"><h3>${escapeHtml(title)}</h3><p>${text ? escapeHtml(text) : "无"}</p>${clean(time) ? `<time>${escapeHtml(formatTime(time))}</time>` : ""}</article>`;
  }

  function renderComments(record) {
    const originalStore = first(record.initialStoreNote, record.note, record.message, record.applicantNote);
    const originalHq = first(record.initialHqNote, record.reviewNote, record.hqReviewNote, record.approvalNote, record.rejectionNote);
    const cards = [
      commentCard("门店原申请留言", originalStore, first(record.createdAt, record.submittedAt)),
      commentCard("总部原审核留言", originalHq, first(record.reviewedAt, record.approvedAt, record.rejectedAt)),
      commentCard("门店作废申请留言", record.voidStoreNote, record.voidSubmittedAt),
      commentCard("总部作废审核留言", record.voidReviewNote, record.voidReviewedAt)
    ];
    $("orderComments").innerHTML = cards.join("");
    $("orderCommentsCount").textContent = "4 项";
    $("orderCommentsHint").textContent = "原申请和作废申请均按门店／总部保留；未填写内容显示“无”。";
  }

  function renderRechargeReviewMessages(record) {
    const storeMessage = first(record?.initialStoreNote, record?.note, record?.message, record?.applicantNote);
    const hqMessage = first(record?.initialHqNote, record?.reviewNote, record?.hqReviewNote, record?.approvalNote, record?.rejectionNote);
    $("reviewPanelTitle").textContent = "总部审核";
    $("reviewPanelHint").textContent = "门店原申请留言和总部回复集中显示；长内容可在各自区域内上下滚动。";
    $("rechargeStoreMessage").textContent = storeMessage || "无";
    $("rechargeHqMessage").textContent = hqMessage || "无";
    $("rechargeStoreMessageTime").textContent = formatTime(first(record?.createdAt, record?.submittedAt)) || "—";
    $("rechargeHqMessageTime").textContent = formatTime(first(record?.reviewedAt, record?.approvedAt, record?.rejectedAt)) || "—";
  }

  function combinedStoreMessage(record) {
    const messages = [];
    const applicationMessage = first(record?.initialStoreNote, record?.note, record?.message, record?.applicantNote);
    const supplementMessage = first(record?.supplementNote);
    if (applicationMessage) messages.push(applicationMessage);
    if (supplementMessage && supplementMessage !== applicationMessage) messages.push(`补录原因：${supplementMessage}`);
    return messages.join("\n\n");
  }

  function renderVerificationMessages(record) {
    const storeMessage = combinedStoreMessage(record);
    $("reviewPanelTitle").textContent = "门店留言";
    $("verificationStoreMessage").textContent = storeMessage || "无";
  }

  function verificationFaceSubjectType(record = currentRecord, payload = currentVerificationPhotoPayload) {
    const explicit = clean(first(payload?.faceSubjectType, payload?.face_subject_type, record?.faceSubjectType, record?.face_subject_type)).toUpperCase();
    if (["TEACHER", "CUSTOMER"].includes(explicit)) return explicit;
    const kind = clean(first(record?.originalType, record?.verificationType, record?.applicationType, record?.originalKind)).toUpperCase();
    return kind === "EXPERIENCE" || kind.includes("体验") ? "TEACHER" : "CUSTOMER";
  }

  function photoSlotLabel(slot) {
    const teacherFace = verificationFaceSubjectType() === "TEACHER";
    if (slot === 0) return teacherFace ? "老师登记照" : "客户原始留存照";
    if (slot === 1) return teacherFace ? "老师本次体验核销照" : "本次核销人脸照";
    return `补充照片 ${slot - 1}`;
  }

  function photoSizeLabel(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return "";
    return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
  }

  function usesMobilePhotoLibrary() {
    const userAgent = String(navigator.userAgent || "");
    return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
      || (navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1);
  }

  function clampVerificationPhotoViewerScale(value) {
    return Math.min(5, Math.max(1, Number(value) || 1));
  }

  function verificationPhotoViewerPointerGeometry(points) {
    const values = Array.from(points || []);
    if (values.length < 2) return null;
    const left = values[0];
    const right = values[1];
    const deltaX = Number(right.x || 0) - Number(left.x || 0);
    const deltaY = Number(right.y || 0) - Number(left.y || 0);
    return {
      distance: Math.max(1, Math.hypot(deltaX, deltaY)),
      centerX: (Number(left.x || 0) + Number(right.x || 0)) / 2,
      centerY: (Number(left.y || 0) + Number(right.y || 0)) / 2
    };
  }

  function verificationPhotoViewerKeyboardAction(key) {
    if (["+", "=", "Add", "PageUp"].includes(key)) return "ZOOM_IN";
    if (["-", "_", "Subtract", "PageDown"].includes(key)) return "ZOOM_OUT";
    if (["0", "Home"].includes(key)) return "RESET";
    if (key === "ArrowLeft") return "PAN_LEFT";
    if (key === "ArrowRight") return "PAN_RIGHT";
    if (key === "ArrowUp") return "PAN_UP";
    if (key === "ArrowDown") return "PAN_DOWN";
    return "";
  }

  function applyVerificationPhotoViewerTransform() {
    const frame = $("verificationPhotoOriginalFrame");
    const image = $("verificationPhotoOriginal");
    const output = $("verificationPhotoZoomValue");
    verificationPhotoViewerScale = clampVerificationPhotoViewerScale(verificationPhotoViewerScale);
    const imageWidth = Number(image?.clientWidth || 0);
    const imageHeight = Number(image?.clientHeight || 0);
    const maxX = Math.max(0, (imageWidth * verificationPhotoViewerScale - Number(frame?.clientWidth || 0)) / 2);
    const maxY = Math.max(0, (imageHeight * verificationPhotoViewerScale - Number(frame?.clientHeight || 0)) / 2);
    verificationPhotoViewerTranslateX = Math.min(maxX, Math.max(-maxX, verificationPhotoViewerTranslateX));
    verificationPhotoViewerTranslateY = Math.min(maxY, Math.max(-maxY, verificationPhotoViewerTranslateY));
    if (verificationPhotoViewerScale === 1) {
      verificationPhotoViewerTranslateX = 0;
      verificationPhotoViewerTranslateY = 0;
    }
    if (image) image.style.transform = `translate3d(${verificationPhotoViewerTranslateX}px, ${verificationPhotoViewerTranslateY}px, 0) scale(${verificationPhotoViewerScale})`;
    if (output) output.value = `${Math.round(verificationPhotoViewerScale * 100)}%`;
    const zoomOut = $("zoomOutVerificationPhoto");
    if (zoomOut) zoomOut.disabled = verificationPhotoViewerScale <= 1;
    const zoomIn = $("zoomInVerificationPhoto");
    if (zoomIn) zoomIn.disabled = verificationPhotoViewerScale >= 5;
  }

  function resetVerificationPhotoViewerTransform() {
    const frame = $("verificationPhotoOriginalFrame");
    for (const pointerId of verificationPhotoViewerPointers.keys()) {
      try {
        if (frame?.hasPointerCapture?.(pointerId)) frame.releasePointerCapture(pointerId);
      } catch (_) { /* 指针可能已经由系统释放 */ }
    }
    verificationPhotoViewerScale = 1;
    verificationPhotoViewerTranslateX = 0;
    verificationPhotoViewerTranslateY = 0;
    verificationPhotoViewerPinch = null;
    verificationPhotoViewerPointers.clear();
    frame?.classList.remove("is-dragging");
    applyVerificationPhotoViewerTransform();
  }

  function zoomVerificationPhotoViewer(nextScale, clientX, clientY) {
    const frame = $("verificationPhotoOriginalFrame");
    const previousScale = verificationPhotoViewerScale;
    const scale = clampVerificationPhotoViewerScale(nextScale);
    if (!frame || scale === previousScale) return applyVerificationPhotoViewerTransform();
    const bounds = frame.getBoundingClientRect();
    const focusX = Number.isFinite(Number(clientX)) ? Number(clientX) - bounds.left - bounds.width / 2 : 0;
    const focusY = Number.isFinite(Number(clientY)) ? Number(clientY) - bounds.top - bounds.height / 2 : 0;
    const contentX = (focusX - verificationPhotoViewerTranslateX) / previousScale;
    const contentY = (focusY - verificationPhotoViewerTranslateY) / previousScale;
    verificationPhotoViewerScale = scale;
    verificationPhotoViewerTranslateX = focusX - contentX * scale;
    verificationPhotoViewerTranslateY = focusY - contentY * scale;
    applyVerificationPhotoViewerTransform();
  }

  function handleVerificationPhotoViewerPointerDown(event) {
    const frame = $("verificationPhotoOriginalFrame");
    if (!frame || !$('verificationPhotoOriginal')?.getAttribute("src")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    verificationPhotoViewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { frame.setPointerCapture(event.pointerId); } catch (_) { /* 部分旧版 Safari 不支持捕获 */ }
    frame.classList.add("is-dragging");
    verificationPhotoViewerPinch = verificationPhotoViewerPointerGeometry(verificationPhotoViewerPointers.values());
  }

  function handleVerificationPhotoViewerPointerMove(event) {
    if (!verificationPhotoViewerPointers.has(event.pointerId)) return;
    event.preventDefault();
    const previous = verificationPhotoViewerPointers.get(event.pointerId);
    verificationPhotoViewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (verificationPhotoViewerPointers.size >= 2) {
      const geometry = verificationPhotoViewerPointerGeometry(verificationPhotoViewerPointers.values());
      if (geometry && verificationPhotoViewerPinch) {
        verificationPhotoViewerTranslateX += geometry.centerX - verificationPhotoViewerPinch.centerX;
        verificationPhotoViewerTranslateY += geometry.centerY - verificationPhotoViewerPinch.centerY;
        zoomVerificationPhotoViewer(verificationPhotoViewerScale * geometry.distance / verificationPhotoViewerPinch.distance, geometry.centerX, geometry.centerY);
      }
      verificationPhotoViewerPinch = geometry;
      return;
    }
    verificationPhotoViewerPinch = null;
    verificationPhotoViewerTranslateX += event.clientX - previous.x;
    verificationPhotoViewerTranslateY += event.clientY - previous.y;
    applyVerificationPhotoViewerTransform();
  }

  function handleVerificationPhotoViewerPointerEnd(event) {
    const frame = $("verificationPhotoOriginalFrame");
    verificationPhotoViewerPointers.delete(event.pointerId);
    if (event.type !== "lostpointercapture") {
      try { frame?.releasePointerCapture(event.pointerId); } catch (_) { /* 已释放 */ }
    }
    verificationPhotoViewerPinch = verificationPhotoViewerPointerGeometry(verificationPhotoViewerPointers.values());
    if (!verificationPhotoViewerPointers.size) frame?.classList.remove("is-dragging");
  }

  function handleVerificationPhotoViewerWheel(event) {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.16 : 1 / 1.16;
    zoomVerificationPhotoViewer(verificationPhotoViewerScale * factor, event.clientX, event.clientY);
  }

  function handleVerificationPhotoViewerKeydown(event) {
    const action = verificationPhotoViewerKeyboardAction(event.key);
    if (!action) return;
    event.preventDefault();
    if (action === "ZOOM_IN") return zoomVerificationPhotoViewer(verificationPhotoViewerScale * 1.25);
    if (action === "ZOOM_OUT") return zoomVerificationPhotoViewer(verificationPhotoViewerScale / 1.25);
    if (action === "RESET") return resetVerificationPhotoViewerTransform();
    if (verificationPhotoViewerScale <= 1) return;
    const step = 48;
    if (action === "PAN_LEFT") verificationPhotoViewerTranslateX += step;
    if (action === "PAN_RIGHT") verificationPhotoViewerTranslateX -= step;
    if (action === "PAN_UP") verificationPhotoViewerTranslateY += step;
    if (action === "PAN_DOWN") verificationPhotoViewerTranslateY -= step;
    applyVerificationPhotoViewerTransform();
  }

  function resetVerificationPhotoPanel(message = "正在读取私有照片权限与缩略图…") {
    const panel = $("verificationPhotoPanel");
    if (!panel) return;
    currentVerificationPhotoPayload = null;
    verificationPhotoRequest += 1;
    $("verificationPhotoCount").textContent = "已绑定 0 / 5";
    $("verificationPhotoHint").textContent = message;
    $("verificationPhotoGrid").innerHTML = Array.from({ length: 5 }, (_, slot) => `
      <article class="verification-photo-card">
        <div class="verification-photo-preview"><span>${slot < 2 ? "正在读取只读照片…" : "正在读取…"}</span></div>
        <div class="verification-photo-card-body"><div><strong>${escapeHtml(photoSlotLabel(slot))}</strong><span>—</span></div></div>
      </article>`).join("");
    $("verificationPhotoMessage").className = "verification-photo-message";
    $("verificationPhotoMessage").textContent = "";
  }

  function preloadVerificationPhotoOriginal(photo, explicitIntent = false) {
    const url = clean(photo?.originalUrl);
    const bytes = Number(photo?.originalBytes || 0);
    if (!url) return null;
    const existing = verificationPhotoPreloads.get(url);
    if (existing) {
      verificationPhotoPreloads.delete(url);
      verificationPhotoPreloads.set(url, existing);
      if (explicitIntent) existing.fetchPriority = "high";
      return existing;
    }
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!explicitIntent && (connection?.saveData === true || /(^|-)2g$/i.test(String(connection?.effectiveType || "")))) return null;
    if (!explicitIntent && (!bytes || bytes > 3 * 1024 * 1024)) return null;
    const preload = new Image();
    preload.decoding = "async";
    preload.referrerPolicy = "no-referrer";
    preload.fetchPriority = explicitIntent ? "high" : "low";
    verificationPhotoPreloads.set(url, preload);
    while (verificationPhotoPreloads.size > 2) verificationPhotoPreloads.delete(verificationPhotoPreloads.keys().next().value);
    preload.addEventListener("error", () => {
      if (verificationPhotoPreloads.get(url) === preload) verificationPhotoPreloads.delete(url);
    }, { once: true });
    preload.src = url;
    return preload;
  }

  function scheduleVerificationPhotoPreloads(photos) {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (connection?.saveData === true || /(^|-)2g$/i.test(String(connection?.effectiveType || ""))) return;
    const priorityPhotos = photos.filter((photo) => Number(photo?.slot) < 2 && clean(photo?.originalUrl));
    if (!priorityPhotos.length) return;
    const run = () => priorityPhotos.forEach((photo) => preloadVerificationPhotoOriginal(photo, true));
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 350 });
    else setTimeout(run, 120);
  }

  async function waitForVerificationPhotoPreload(url, photo) {
    const preload = preloadVerificationPhotoOriginal({ ...photo, originalUrl: url }, true);
    if (!preload) throw new Error("高清原图地址无效");
    if (preload.complete && preload.naturalWidth) return preload;
    if (typeof preload.decode === "function") {
      try {
        await preload.decode();
        if (preload.naturalWidth) return preload;
      } catch (_) { /* 旧版 Safari 改用 load 事件 */ }
    }
    await new Promise((resolve, reject) => {
      if (preload.complete) return preload.naturalWidth ? resolve() : reject(new Error("高清原图解码失败"));
      preload.addEventListener("load", resolve, { once: true });
      preload.addEventListener("error", () => reject(new Error("高清原图载入失败")), { once: true });
    });
    return preload;
  }

  function revokeVerificationPhotoLocalPreview(slot) {
    const normalizedSlot = Number(slot);
    const preview = verificationPhotoLocalPreviews.get(normalizedSlot);
    if (!preview) return;
    if (preview.remoteProbe) {
      preview.remoteProbe.onload = null;
      preview.remoteProbe.onerror = null;
    }
    [preview.thumbnailUrl, preview.originalUrl].forEach((url) => {
      if (clean(url).startsWith("blob:")) URL.revokeObjectURL(url);
    });
    verificationPhotoLocalPreviews.delete(normalizedSlot);
  }

  function clearVerificationPhotoLocalPreviews() {
    Array.from(verificationPhotoLocalPreviews.keys()).forEach(revokeVerificationPhotoLocalPreview);
  }

  function mergeVerificationPhotoLocalPreviews(payload, recordId) {
    const photos = Array.isArray(payload?.photos) ? payload.photos.map((photo) => ({ ...photo })) : [];
    const bySlot = new Map(photos.map((photo) => [Number(photo.slot), photo]));
    verificationPhotoLocalPreviews.forEach((preview, slot) => {
      if (clean(preview.recordId) !== clean(recordId)) return;
      const remotePhoto = bySlot.get(slot) || {};
      bySlot.set(slot, {
        ...preview.photo,
        ...remotePhoto,
        slot,
        thumbnailUrl: preview.thumbnailUrl,
        originalUrl: preview.originalUrl,
        originalUrlExpiresAt: Number.MAX_SAFE_INTEGER,
        localPreview: true
      });
    });
    return {
      ...payload,
      photos: Array.from(bySlot.values()).sort((left, right) => Number(left.slot) - Number(right.slot))
    };
  }

  function promoteUsableVerificationPhotoPreviews(payload, recordId, request) {
    const remoteBySlot = new Map((Array.isArray(payload?.photos) ? payload.photos : []).map((photo) => [Number(photo.slot), photo]));
    verificationPhotoLocalPreviews.forEach((preview, slot) => {
      if (clean(preview.recordId) !== clean(recordId)) return;
      const remotePhoto = remoteBySlot.get(slot);
      const remoteThumbnailUrl = clean(remotePhoto?.thumbnailUrl);
      if (!remoteThumbnailUrl || preview.remoteProbeUrl === remoteThumbnailUrl) return;
      const probe = new Image();
      preview.remoteProbe = probe;
      preview.remoteProbeUrl = remoteThumbnailUrl;
      probe.decoding = "async";
      probe.referrerPolicy = "no-referrer";
      probe.fetchPriority = "high";
      probe.onload = () => {
        if (request !== verificationPhotoRequest || verificationPhotoLocalPreviews.get(slot) !== preview) return;
        revokeVerificationPhotoLocalPreview(slot);
        renderVerificationPhotos(mergeVerificationPhotoLocalPreviews(payload, recordId), recordId);
        setVerificationPhotoButtonsDisabled(verificationPhotoUploadBusy);
      };
      probe.onerror = () => {
        if (verificationPhotoLocalPreviews.get(slot) !== preview) return;
        preview.remoteProbe = null;
        preview.remoteProbeUrl = "";
      };
      probe.src = remoteThumbnailUrl;
    });
  }

  function revokeVerificationPhotoThumbnailFallback(key) {
    const url = verificationPhotoThumbnailFallbacks.get(key);
    if (!url) return;
    verificationPhotoThumbnailFallbacks.delete(key);
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  function clearVerificationPhotoThumbnailFallbacks() {
    Array.from(verificationPhotoThumbnailFallbacks.keys()).forEach(revokeVerificationPhotoThumbnailFallback);
  }

  function probeVerificationPhotoImage(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        probe.onload = null;
        probe.onerror = null;
        if (error) reject(error);
        else resolve(probe);
      };
      const timer = window.setTimeout(() => finish(new Error("缩略图读取超时")), timeoutMs);
      probe.decoding = "async";
      probe.referrerPolicy = "no-referrer";
      probe.onload = () => finish(probe.naturalWidth ? null : new Error("缩略图解码失败"));
      probe.onerror = () => finish(new Error("缩略图载入失败"));
      probe.src = url;
    });
  }

  function verificationPhotoPreviewButton(target) {
    if (target?.matches?.("[data-view-verification-photo]")) return target;
    return target?.closest?.("[data-view-verification-photo]") || null;
  }

  function renderVerificationPhotoThumbnailFailure(target, slot) {
    const button = verificationPhotoPreviewButton(target) || target;
    if (!button?.isConnected) return;
    const fallback = document.createElement("span");
    fallback.textContent = "预览读取失败\n点击重新读取这一张";
    fallback.style.whiteSpace = "pre-line";
    fallback.setAttribute("role", "status");
    fallback.setAttribute("aria-label", `${photoSlotLabel(slot)}预览读取失败`);
    button.dataset.photoPreviewState = "failed";
    button.setAttribute("aria-label", `${photoSlotLabel(slot)}预览读取失败，点击重新读取这一张`);
    button.replaceChildren(fallback);
  }

  function displayRecoveredVerificationPhotoThumbnail(target, url, slot) {
    const button = verificationPhotoPreviewButton(target) || target;
    let image = button.matches?.("img") ? button : button.querySelector?.("img");
    if (!image) {
      image = document.createElement("img");
      button.replaceChildren(image);
    }
    button.dataset.photoPreviewState = "ready";
    button.setAttribute("aria-label", `查看${photoSlotLabel(slot)}原图`);
    image.dataset.photoRecovery = "recovered";
    image.dataset.verificationThumbnailSlot = String(slot);
    image.alt = `${photoSlotLabel(slot)}缩略图`;
    image.loading = "eager";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.fetchPriority = "high";
    image.addEventListener("error", () => renderVerificationPhotoThumbnailFailure(button, slot), { once: true });
    image.src = url;
    return image;
  }

  async function fetchVerificationPhotoThumbnailFallback(recordId, slot) {
    const payload = await callVerificationPhotoRead({ action: "getVerificationPhotoThumbnailData", recordId, slot });
    return verificationPhotoDataBlob(payload.imageBase64, slot);
  }

  async function recoverVerificationPhotoThumbnail(recordId, slot, target, listedPhoto, request) {
    const button = verificationPhotoPreviewButton(target) || target;
    if (!button?.isConnected || button.dataset.photoRecovery === "running") return;
    button.dataset.photoRecovery = "running";
    button.dataset.photoPreviewState = "loading";
    const existingImage = button.matches?.("img") ? button : button.querySelector?.("img");
    const failedUrl = clean(existingImage?.getAttribute("src"));
    const loading = document.createElement("span");
    loading.textContent = "正在重新读取这一张…";
    loading.setAttribute("role", "status");
    button.replaceChildren(loading);
    let photo = listedPhoto;
    const isCurrent = () => request === verificationPhotoRequest && button.isConnected;
    try {
      try {
        const payload = await fetchVerificationPhotoManifest(recordId);
        if (!isCurrent()) return;
        const refreshed = payload.photos.find((candidate) => Number(candidate?.slot) === Number(slot));
        if (refreshed) {
          if (clean(refreshed.uploadedAt) && clean(refreshed.uploadedAt) !== clean(photo?.uploadedAt)) {
            if (photo?.localPreview) revokeVerificationPhotoLocalPreview(slot);
            renderVerificationPhotos(mergeVerificationPhotoLocalPreviews(payload, recordId), recordId);
            return;
          }
          const refreshedAt = Date.now();
          refreshed.originalUrlExpiresAt = refreshed.localPreview === true || verificationPhotoUrlNeverExpires(refreshed.originalUrl)
            ? Number.MAX_SAFE_INTEGER
            : refreshedAt + Math.max(0, Number(refreshed?.originalUrlExpiresIn ?? payload?.expiresIn ?? 0) * 1000);
          if (photo && typeof photo === "object") Object.assign(photo, refreshed);
          photo = photo || refreshed;
          const refreshedThumbnail = clean(refreshed.thumbnailUrl);
          if (refreshedThumbnail && refreshedThumbnail !== failedUrl) {
            await probeVerificationPhotoImage(refreshedThumbnail);
            if (!isCurrent()) return;
            displayRecoveredVerificationPhotoThumbnail(button, refreshedThumbnail, slot);
            return;
          }
        }
      } catch (_) {
        // The authorized original/base64 path below remains available when manifest refresh fails.
      }
      let blob = null;
      try {
        blob = await fetchVerificationPhotoThumbnailFallback(recordId, slot);
      } catch (_) {
        blob = await fetchVerificationPhotoBlob(recordId, photo || { slot });
      }
      if (!isCurrent()) return;
      const fallbackUrl = URL.createObjectURL(blob);
      if (!isCurrent()) {
        URL.revokeObjectURL(fallbackUrl);
        return;
      }
      const fallbackKey = `${clean(recordId)}:${Number(slot)}`;
      revokeVerificationPhotoThumbnailFallback(fallbackKey);
      verificationPhotoThumbnailFallbacks.set(fallbackKey, fallbackUrl);
      displayRecoveredVerificationPhotoThumbnail(button, fallbackUrl, slot);
    } catch (_) {
      if (isCurrent()) renderVerificationPhotoThumbnailFailure(button, slot);
    } finally {
      if (button?.dataset) delete button.dataset.photoRecovery;
    }
  }

  function verificationPhotoCard(photo, slot, payload) {
    const label = photoSlotLabel(slot);
    const canUpload = slot >= 2 && payload.canEdit === true;
    const previewFailure = clean(photo?.thumbnailError).toUpperCase() === "PHOTO_NOT_FOUND"
      ? "存储文件未找到"
      : "预览地址暂不可用";
    const preview = photo
      ? `<button class="verification-photo-preview has-photo" type="button" data-view-verification-photo="${slot}" data-photo-preview-state="${photo.thumbnailUrl ? "loading" : "failed"}" aria-label="查看${escapeHtml(label)}原图">${photo.thumbnailUrl ? `<img src="${escapeHtml(photo.thumbnailUrl)}" data-verification-thumbnail-slot="${slot}" alt="${escapeHtml(label)}缩略图" loading="eager" fetchpriority="high" decoding="async" referrerpolicy="no-referrer">` : `<span>${escapeHtml(previewFailure)}<br>点击重新读取这一张</span>`}</button>`
      : `<div class="verification-photo-preview"><span>${slot < 2 ? `未保存${escapeHtml(photoSlotLabel(slot))}` : "尚未上传"}</span></div>`;
    const size = photoSizeLabel(photo?.originalBytes);
    const meta = photo ? [size, formatTime(photo.uploadedAt) || "已绑定"].filter(Boolean).join(" · ") : "空照片位";
    const libraryLabel = usesMobilePhotoLibrary() ? (photo ? "从相册替换" : "从相册上传") : (photo ? "上传替换" : "上传文件");
    const downloadLabel = usesMobilePhotoLibrary() ? "保存高清原图到相册" : "下载高清原图";
    const download = photo
      ? `<button class="verification-photo-upload verification-photo-download" type="button" data-download-verification-photo="${slot}">${downloadLabel}</button>`
      : "";
    const editActions = slot < 2 ? "" : `
      <button class="verification-photo-upload verification-photo-camera" type="button" data-capture-verification-photo="${slot}" ${canUpload ? "" : "disabled"}>${photo ? "重新拍照" : "拍照"}</button>
      <button class="verification-photo-upload" type="button" data-upload-verification-photo="${slot}" ${canUpload ? "" : "disabled"}>${libraryLabel}</button>`;
    const actions = download || editActions
      ? `<div class="verification-photo-actions">${download}${editActions}</div>`
      : "";
    return `<article class="verification-photo-card">${preview}<div class="verification-photo-card-body"><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(meta)}</span></div>${actions}</div></article>`;
  }

  function renderVerificationPhotos(payload, recordId) {
    const photos = Array.isArray(payload?.photos) ? payload.photos.map((photo) => ({ ...photo })) : [];
    const loadedAt = Date.now();
    photos.forEach((photo) => {
      photo.originalUrlExpiresAt = photo.localPreview === true || verificationPhotoUrlNeverExpires(photo.originalUrl)
        ? Number.MAX_SAFE_INTEGER
        : loadedAt + Math.max(0, Number(photo?.originalUrlExpiresIn ?? payload?.expiresIn ?? 0) * 1000);
    });
    currentVerificationPhotoPayload = { ...payload, photos, loadedAt, error: null };
    const bySlot = new Map(photos.map((photo) => [Number(photo.slot), photo]));
    $("verificationPhotoCount").textContent = `已绑定 ${photos.length} / 5`;
    const deadline = formatTime(payload?.editableUntil);
    const immutableFacePhotos = verificationFaceSubjectType() === "TEACHER"
      ? "老师登记照与老师本次体验核销照"
      : "客户留存照与本次核销人脸照";
    $("verificationPhotoHint").textContent = payload?.canEdit
      ? `你是本单提交人，可在 ${deadline || "提交后 24 小时内"} 前上传或替换 3 张补充照片。${immutableFacePhotos}均不可修改。`
      : payload?.isSubmitter
      ? `照片修改窗口已于 ${deadline || "提交后 24 小时"} 结束；现有照片永久只读。`
      : "照片仅供有权查看本核销单的账号浏览；只有本单提交人可在 24 小时内上传或替换补充照片。";
    clearVerificationPhotoThumbnailFallbacks();
    $("verificationPhotoGrid").innerHTML = Array.from({ length: 5 }, (_, slot) => verificationPhotoCard(bySlot.get(slot), slot, payload)).join("");
    const renderRequest = verificationPhotoRequest;
    $("verificationPhotoGrid").querySelectorAll("[data-verification-thumbnail-slot]").forEach((image) => {
      const slot = Number(image.dataset.verificationThumbnailSlot);
      const button = verificationPhotoPreviewButton(image);
      const recover = () => void recoverVerificationPhotoThumbnail(recordId, slot, image, bySlot.get(slot), renderRequest);
      image.addEventListener("load", () => { if (button) button.dataset.photoPreviewState = "ready"; }, { once: true });
      image.addEventListener("error", recover, { once: true });
      if (image.complete && !image.naturalWidth) {
        if (typeof queueMicrotask === "function") queueMicrotask(recover);
        else Promise.resolve().then(recover);
      }
    });
    $("verificationPhotoGrid").querySelectorAll("[data-view-verification-photo]").forEach((button) => {
      const slot = Number(button.dataset.viewVerificationPhoto);
      const photo = bySlot.get(slot);
      const warmOriginal = () => preloadVerificationPhotoOriginal(photo, true);
      button.addEventListener("pointerenter", warmOriginal, { once: true });
      button.addEventListener("focus", warmOriginal, { once: true });
      button.addEventListener("touchstart", warmOriginal, { once: true, passive: true });
      button.addEventListener("click", () => {
        if (button.dataset.photoPreviewState === "failed") {
          void recoverVerificationPhotoThumbnail(recordId, slot, button, photo, renderRequest);
          return;
        }
        openVerificationPhoto(recordId, slot);
      });
      if (photo && !clean(photo.thumbnailUrl)) {
        void recoverVerificationPhotoThumbnail(recordId, slot, button, photo, renderRequest);
      }
    });
    $("verificationPhotoGrid").querySelectorAll("[data-download-verification-photo]").forEach((button) => {
      const slot = Number(button.dataset.downloadVerificationPhoto);
      button.addEventListener("click", () => void downloadVerificationPhotoOriginal(recordId, bySlot.get(slot), button));
    });
    $("verificationPhotoGrid").querySelectorAll("[data-capture-verification-photo]").forEach((button) => {
      button.addEventListener("click", () => openVerificationPhotoCamera(recordId, Number(button.dataset.captureVerificationPhoto)));
    });
    $("verificationPhotoGrid").querySelectorAll("[data-upload-verification-photo]").forEach((button) => {
      button.addEventListener("click", () => chooseVerificationPhoto(recordId, Number(button.dataset.uploadVerificationPhoto)));
    });
    scheduleVerificationPhotoPreloads(photos);
  }

  async function loadVerificationPhotos(record) {
    const recordId = clean(record?.id);
    if (!$("verificationPhotoPanel")) return;
    resetVerificationPhotoPanel();
    const request = verificationPhotoRequest;
    if (record?.databaseBacked !== true || !/^\d+$/.test(recordId)) {
      $("verificationPhotoHint").textContent = "当前不是数据库核销单，无法读取私有照片。";
      return;
    }
    try {
      const payload = await callVerificationPhotoRead({ action: "getVerificationPhotos", recordId });
      if (request !== verificationPhotoRequest) return;
      renderVerificationPhotos(payload, recordId);
      return payload;
    } catch (error) {
      if (request !== verificationPhotoRequest) return;
      currentVerificationPhotoPayload = { photos: [], error };
      $("verificationPhotoHint").textContent = "核销照片读取失败";
      $("verificationPhotoMessage").className = "verification-photo-message error";
      $("verificationPhotoMessage").textContent = error?.message || "请核对迁移 037—039、私有存储桶和 verificationPhoto v1 云函数";
      $("verificationPhotoGrid").innerHTML = "";
      return null;
    }
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("浏览器无法生成 JPEG 照片")), "image/jpeg", quality));
  }

  function verificationPhotoUploadError(message, code = "PHOTO_UPLOAD_FAILED") {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function verificationPhotoUploadCanceled() {
    return verificationPhotoUploadError("照片上传已取消", "PHOTO_UPLOAD_CANCELED");
  }

  function verificationPhotoBlobDataUrl(blob) {
    if (!(blob instanceof Blob) || !blob.size) {
      return Promise.reject(verificationPhotoUploadError("照片处理结果无效", "PHOTO_UPLOAD_SOURCE_INVALID"));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const value = clean(reader.result);
        if (/^data:image\/jpeg;base64,/i.test(value)) resolve(value);
        else reject(verificationPhotoUploadError("浏览器无法准备照片上传数据", "PHOTO_UPLOAD_SOURCE_INVALID"));
      }, { once: true });
      reader.addEventListener("error", () => reject(verificationPhotoUploadError("读取待上传照片失败", "PHOTO_UPLOAD_SOURCE_INVALID")), { once: true });
      reader.addEventListener("abort", () => reject(verificationPhotoUploadCanceled()), { once: true });
      reader.readAsDataURL(blob);
    });
  }

  function isVerificationPhotoUploadCanceled(error) {
    return error?.code === "PHOTO_UPLOAD_CANCELED" || error?.name === "AbortError";
  }

  function assertVerificationPhotoTask(task) {
    if (!task || task.cancelRequested || verificationPhotoUploadTask !== task) throw verificationPhotoUploadCanceled();
  }

  function yieldVerificationPhotoWork(task) {
    return new Promise((resolve, reject) => {
      const resume = () => {
        try { assertVerificationPhotoTask(task); resolve(); }
        catch (error) { reject(error); }
      };
      if (document.hidden) setTimeout(resume, 0);
      else requestAnimationFrame(resume);
    });
  }

  function cancelVerificationPhotoTaskDismiss() {
    if (verificationPhotoSuccessDismissTimer) window.clearTimeout(verificationPhotoSuccessDismissTimer);
    verificationPhotoSuccessDismissTimer = 0;
    $("verificationPhotoUploadTask")?.classList.remove("is-dismissing");
  }

  function scheduleVerificationPhotoTaskDismiss() {
    cancelVerificationPhotoTaskDismiss();
    const bar = $("verificationPhotoUploadTask");
    if (!bar) return;
    verificationPhotoSuccessDismissTimer = window.setTimeout(() => {
      verificationPhotoSuccessDismissTimer = 0;
      if (verificationPhotoUploadTask || bar.dataset.state !== "success") return;
      bar.classList.add("is-dismissing");
      verificationPhotoSuccessDismissTimer = window.setTimeout(() => {
        verificationPhotoSuccessDismissTimer = 0;
        if (verificationPhotoUploadTask || bar.dataset.state !== "success") return;
        bar.hidden = true;
        bar.classList.remove("is-dismissing");
      }, 180);
    }, 3000);
  }

  function updateVerificationPhotoTaskUi(task, options = {}) {
    const bar = $("verificationPhotoUploadTask");
    if (!bar) return;
    cancelVerificationPhotoTaskDismiss();
    const progress = Math.max(0, Math.min(100, Number(options.progress ?? task?.progress ?? 0)));
    if (task) task.progress = progress;
    bar.hidden = false;
    const state = clean(options.state || task?.state || "PREPARING").toUpperCase();
    bar.dataset.state = state.toLowerCase();
    $("verificationPhotoUploadTaskTitle").textContent = options.title || `${photoSlotLabel(task?.slot)}上传任务`;
    $("verificationPhotoUploadTaskDetail").textContent = options.detail || "正在准备照片…";
    const meter = $("verificationPhotoUploadProgress");
    const stageProgressText = {
      PREPARING: "处理中",
      AUTHORIZING: "连接中",
      WAITING: "等待中",
      COMMITTING: "保存中",
      CANCELING: "停止中",
      RECOVERING: "恢复中"
    }[state] || "";
    const indeterminate = options.indeterminate === true || Boolean(stageProgressText);
    const progressText = clean(options.progressText) || stageProgressText || `${Math.round(progress)}%`;
    if (meter) {
      if (indeterminate) meter.removeAttribute("value");
      else meter.value = progress;
      meter.setAttribute("aria-valuetext", progressText);
    }
    $("verificationPhotoUploadPercent").textContent = progressText;
    const cancel = $("cancelVerificationPhotoUpload");
    if (cancel) {
      cancel.hidden = options.canCancel === false;
      cancel.disabled = options.cancelDisabled === true;
      cancel.textContent = options.cancelLabel || "取消上传";
    }
    const retry = $("retryVerificationPhotoUpload");
    if (retry) {
      retry.hidden = options.canRetry !== true;
      retry.disabled = options.canRetry !== true || verificationPhotoUploadBusy;
    }
  }

  function setVerificationPhotoTaskStage(task, state, title, detail, progress, options = {}) {
    if (!task) return;
    task.state = state;
    updateVerificationPhotoTaskUi(task, { state, title, detail, progress, ...options });
    const message = $("verificationPhotoMessage");
    if (message) {
      message.className = `verification-photo-message${options.error ? " error" : ""}`;
      message.textContent = detail || title || "";
    }
  }

  function verificationPhotoCancellationCopy(outcome, failure = null) {
    if (outcome === "failed") {
      const failureMessage = clean(failure?.message) || "照片没有上传完成";
      return {
        title: "上传未完成，正在恢复",
        detail: `${failureMessage}；正在清理本次未完成任务，完成后即可重新上传。`,
        progressText: "恢复中",
        cancelLabel: "正在恢复…"
      };
    }
    return {
      title: "正在停止上传",
      detail: "正在停止本次上传。出现“已取消”后，就可以重新拍照或选择文件。",
      progressText: "停止中",
      cancelLabel: "正在停止…"
    };
  }

  function setVerificationPhotoButtonsDisabled(disabled) {
    $("verificationPhotoGrid")?.querySelectorAll("[data-capture-verification-photo], [data-upload-verification-photo]").forEach((button) => {
      button.disabled = disabled || currentVerificationPhotoPayload?.canEdit !== true;
    });
  }

  async function decodePhotoFile(file) {
    if (!file || file.size <= 0) throw new Error("请选择一张有效照片");
    if (file.size > 20 * 1024 * 1024) throw new Error("原始文件不能超过 20 MB");
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (_) { /* Older browsers fall back to an Image element below. */ }
    }
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.addEventListener("load", () => { URL.revokeObjectURL(url); resolve(image); }, { once: true });
      image.addEventListener("error", () => { URL.revokeObjectURL(url); reject(new Error("不支持该照片格式，请使用相机、JPEG 或 PNG")); }, { once: true });
      image.src = url;
    });
  }

  async function prepareVerificationPhotoOnMainThread(file, task) {
    await yieldVerificationPhotoWork(task);
    const image = await decodePhotoFile(file);
    assertVerificationPhotoTask(task);
    const naturalWidth = Number(image.width || image.naturalWidth || 0);
    const naturalHeight = Number(image.height || image.naturalHeight || 0);
    if (!naturalWidth || !naturalHeight) throw new Error("无法读取照片尺寸");
    const originalScale = Math.min(1, 2400 / Math.max(naturalWidth, naturalHeight));
    const original = document.createElement("canvas");
    original.width = Math.max(1, Math.round(naturalWidth * originalScale));
    original.height = Math.max(1, Math.round(naturalHeight * originalScale));
    const thumbnail = document.createElement("canvas");
    let reduced = null;
    try {
      original.getContext("2d", { alpha: false, desynchronized: true }).drawImage(image, 0, 0, original.width, original.height);
      image.close?.();
      await yieldVerificationPhotoWork(task);
      let originalBlob = await canvasBlob(original, 0.92);
      assertVerificationPhotoTask(task);
      if (originalBlob.size > 3 * 1024 * 1024) originalBlob = await canvasBlob(original, 0.86);
      if (originalBlob.size > 3 * 1024 * 1024) {
        await yieldVerificationPhotoWork(task);
        const reducedScale = Math.min(1, 1800 / Math.max(original.width, original.height));
        reduced = document.createElement("canvas");
        reduced.width = Math.max(1, Math.round(original.width * reducedScale));
        reduced.height = Math.max(1, Math.round(original.height * reducedScale));
        reduced.getContext("2d", { alpha: false, desynchronized: true }).drawImage(original, 0, 0, reduced.width, reduced.height);
        original.width = reduced.width; original.height = reduced.height;
        original.getContext("2d", { alpha: false }).drawImage(reduced, 0, 0);
        originalBlob = await canvasBlob(original, 0.88);
      }
      if (originalBlob.size > 3 * 1024 * 1024) throw new Error("照片处理后仍超过 3 MB，请换一张照片");
      await yieldVerificationPhotoWork(task);
      const thumbScale = Math.min(1, 480 / Math.max(original.width, original.height));
      thumbnail.width = Math.max(1, Math.round(original.width * thumbScale));
      thumbnail.height = Math.max(1, Math.round(original.height * thumbScale));
      thumbnail.getContext("2d", { alpha: false, desynchronized: true }).drawImage(original, 0, 0, thumbnail.width, thumbnail.height);
      const thumbnailBlob = await canvasBlob(thumbnail, 0.82);
      assertVerificationPhotoTask(task);
      return { originalBlob, thumbnailBlob, imageWidth: original.width, imageHeight: original.height };
    } finally {
      image.close?.();
      original.width = original.height = 1;
      thumbnail.width = thumbnail.height = 1;
      if (reduced) reduced.width = reduced.height = 1;
    }
  }

  function prepareVerificationPhotoInWorker(file, task) {
    if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") {
      return Promise.reject(verificationPhotoUploadError("后台照片处理不可用", "PHOTO_WORKER_UNAVAILABLE"));
    }
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(`verification-photo-worker.js?v=${encodeURIComponent(VERSION)}`); }
      catch (_) { reject(verificationPhotoUploadError("后台照片处理不可用", "PHOTO_WORKER_UNAVAILABLE")); return; }
      task.worker = worker;
      const finish = () => {
        if (task.worker === worker) task.worker = null;
        if (task.cancelPreparation === cancelPreparation) task.cancelPreparation = null;
        worker.terminate();
      };
      const cancelPreparation = () => {
        finish();
        reject(verificationPhotoUploadCanceled());
      };
      task.cancelPreparation = cancelPreparation;
      worker.addEventListener("message", (event) => {
        const result = event.data || {};
        if (result.id !== task.id) return;
        finish();
        if (task.cancelRequested || verificationPhotoUploadTask !== task) return reject(verificationPhotoUploadCanceled());
        if (!result.ok) return reject(verificationPhotoUploadError(result.message || "浏览器无法处理照片", result.code || "PHOTO_PREPARE_FAILED"));
        resolve({
          originalBlob: result.originalBlob,
          thumbnailBlob: result.thumbnailBlob,
          imageWidth: Number(result.imageWidth || 0),
          imageHeight: Number(result.imageHeight || 0)
        });
      });
      worker.addEventListener("error", () => {
        finish();
        reject(verificationPhotoUploadError("后台照片处理启动失败", "PHOTO_WORKER_UNAVAILABLE"));
      }, { once: true });
      worker.postMessage({ id: task.id, file, maxInputBytes: 20 * 1024 * 1024, maxOutputBytes: 3 * 1024 * 1024 });
    });
  }

  async function prepareVerificationPhotoFromCanvas(canvas, task) {
    assertVerificationPhotoTask(task);
    const width = Number(canvas?.width || 0);
    const height = Number(canvas?.height || 0);
    if (!width || !height) throw new Error("摄像头画面尚未准备好");
    const thumbnail = document.createElement("canvas");
    let reduced = null;
    try {
      let finalCanvas = canvas;
      let finalWidth = width;
      let finalHeight = height;
      let originalBlob = await canvasBlob(finalCanvas, 0.92);
      assertVerificationPhotoTask(task);
      if (originalBlob.size > 3 * 1024 * 1024) originalBlob = await canvasBlob(finalCanvas, 0.86);
      if (originalBlob.size > 3 * 1024 * 1024) {
        await yieldVerificationPhotoWork(task);
        const reducedScale = Math.min(1, 1800 / Math.max(width, height));
        finalWidth = Math.max(1, Math.round(width * reducedScale));
        finalHeight = Math.max(1, Math.round(height * reducedScale));
        reduced = document.createElement("canvas");
        reduced.width = finalWidth;
        reduced.height = finalHeight;
        reduced.getContext("2d", { alpha: false, desynchronized: true }).drawImage(canvas, 0, 0, finalWidth, finalHeight);
        finalCanvas = reduced;
        originalBlob = await canvasBlob(finalCanvas, 0.88);
      }
      if (originalBlob.size > 3 * 1024 * 1024) throw new Error("拍摄照片超过 3 MB，请重试");
      await yieldVerificationPhotoWork(task);
      const scale = Math.min(1, 480 / Math.max(finalWidth, finalHeight));
      thumbnail.width = Math.max(1, Math.round(finalWidth * scale));
      thumbnail.height = Math.max(1, Math.round(finalHeight * scale));
      thumbnail.getContext("2d", { alpha: false, desynchronized: true }).drawImage(finalCanvas, 0, 0, thumbnail.width, thumbnail.height);
      const thumbnailBlob = await canvasBlob(thumbnail, 0.82);
      return { originalBlob, thumbnailBlob, imageWidth: finalWidth, imageHeight: finalHeight };
    } finally {
      thumbnail.width = thumbnail.height = 1;
      if (reduced) reduced.width = reduced.height = 1;
      canvas.width = canvas.height = 1;
    }
  }

  async function prepareVerificationPhoto(file, task, sourceCanvas = null) {
    if (task.prepared) return task.prepared;
    if (sourceCanvas) return prepareVerificationPhotoFromCanvas(sourceCanvas, task);
    try {
      return await prepareVerificationPhotoInWorker(file, task);
    } catch (error) {
      if (!["PHOTO_WORKER_UNAVAILABLE", "PHOTO_DECODE_FAILED"].includes(error?.code)) throw error;
      assertVerificationPhotoTask(task);
      return prepareVerificationPhotoOnMainThread(file, task);
    }
  }

  function directVerificationPhotoUploadUnavailable(error) {
    const code = clean(error?.code).toUpperCase();
    const message = clean(error?.message).toLowerCase();
    return ["ACTION_NOT_FOUND", "UNKNOWN_ACTION", "UNSUPPORTED_ACTION", "PHOTO_UPLOAD_DIRECT_UNAVAILABLE", "DATABASE_SCHEMA_MISSING"].includes(code)
      || ((message.includes("beginverificationphotoupload") || message.includes("不支持的操作")) && (message.includes("not found") || message.includes("unknown") || message.includes("不支持")));
  }

  function signedUploadTarget(value) {
    if (!value) return null;
    if (typeof value === "string") return { url: value, method: "PUT", headers: {} };
    return {
      url: clean(value.url || value.signedUrl),
      method: clean(value.method || "PUT").toUpperCase(),
      contentType: clean(value.contentType || "image/jpeg"),
      expectedBytes: Number(value.expectedBytes || 0),
      headers: {}
    };
  }

  function updateSignedUploadProgress(task) {
    const parts = Object.values(task.uploadParts || {});
    const total = parts.reduce((sum, part) => sum + Number(part.total || 0), 0);
    const loaded = parts.reduce((sum, part) => sum + Math.min(Number(part.loaded || 0), Number(part.total || 0)), 0);
    const percent = total > 0 ? loaded / total : 0;
    const displayPercent = Math.max(0, Math.min(100, Math.round(percent * 100)));
    if (displayPercent < 100 && Number.isFinite(task.lastRenderedUploadPercent)
      && displayPercent < task.lastRenderedUploadPercent + 5) return;
    task.lastRenderedUploadPercent = displayPercent;
    setVerificationPhotoTaskStage(task, "UPLOADING", `${photoSlotLabel(task.slot)}正在上传`, `照片正在上传 ${displayPercent}%（请勿关闭页面）`, displayPercent);
  }

  function uploadVerificationPhotoBlob(task, name, targetValue, blob) {
    const target = signedUploadTarget(targetValue);
    if (!target?.url) return Promise.reject(verificationPhotoUploadError(`${name}上传地址无效`, "PHOTO_UPLOAD_URL_INVALID"));
    task.uploadParts[name] = { loaded: 0, total: blob.size };
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      task.xhrs.add(xhr);
      let settled = false;
      const done = (callback, value) => {
        if (settled) return;
        settled = true;
        task.xhrs.delete(xhr);
        callback(value);
      };
      xhr.open(target.method || "PUT", target.url, true);
      xhr.timeout = 180000;
      if (target.expectedBytes > 0 && target.expectedBytes !== blob.size) {
        done(reject, verificationPhotoUploadError(`${name}大小与服务器授权不一致，请重新选择照片`, "PHOTO_UPLOAD_SIZE_MISMATCH"));
        return;
      }
      xhr.setRequestHeader("Content-Type", target.contentType || blob.type || "image/jpeg");
      xhr.upload.addEventListener("progress", (event) => {
        task.uploadParts[name].loaded = event.lengthComputable ? event.loaded : Math.min(blob.size, event.loaded || 0);
        updateSignedUploadProgress(task);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          task.uploadParts[name].loaded = blob.size;
          updateSignedUploadProgress(task);
          done(resolve);
        } else {
          done(reject, verificationPhotoUploadError(`${name}上传失败（HTTP ${xhr.status || "未知"}）`, "PHOTO_STORAGE_UPLOAD_FAILED"));
        }
      });
      xhr.addEventListener("error", () => done(reject, verificationPhotoUploadError(`${name}网络上传失败，请检查网络以及 CloudBase Web 安全域名／存储 CORS 配置后重试`, "PHOTO_STORAGE_NETWORK_FAILED")));
      xhr.addEventListener("timeout", () => done(reject, verificationPhotoUploadError(`${name}上传超时，请重试`, "PHOTO_STORAGE_TIMEOUT")));
      xhr.addEventListener("abort", () => done(reject, verificationPhotoUploadCanceled()));
      xhr.send(blob);
    });
  }

  function verificationPhotoUploadStatus(payload) {
    return clean(payload?.status || payload?.requestStatus || payload?.uploadStatus).toUpperCase();
  }

  function verificationPhotoUploadTerminal(status) {
    return ["COMMITTED", "COMPLETED", "CANCELED", "CANCELLED", "FAILED", "EXPIRED"].includes(clean(status).toUpperCase());
  }

  function verificationPhotoUploadRequestNotFound(error) {
    return ["PHOTO_UPLOAD_REQUEST_NOT_FOUND", "PHOTO_UPLOAD_NOT_FOUND"].includes(clean(error?.code).toUpperCase());
  }

  function verificationPhotoRetryFromTask(task) {
    return {
      recordId: task.recordId,
      slot: task.slot,
      file: task.file,
      prepared: task.prepared,
      source: task.source
    };
  }

  function verificationPhotoManifestReady() {
    return currentVerificationPhotoPayload && !currentVerificationPhotoPayload.error && Array.isArray(currentVerificationPhotoPayload.photos);
  }

  function finishVerificationPhotoTask(task, outcome, detail, options = {}) {
    if (verificationPhotoUploadTask !== task) return;
    task.worker?.terminate?.();
    task.cancelPreparation?.();
    task.cancelPreparation = null;
    task.xhrs?.forEach((xhr) => { try { xhr.abort(); } catch (_) { /* 已结束 */ } });
    task.xhrs?.clear?.();
    verificationPhotoUploadTask = null;
    verificationPhotoUploadBusy = false;
    const retryRequested = outcome === "failed" || outcome === "canceled";
    const hasRetrySource = Boolean(task.prepared?.originalBlob && task.prepared?.thumbnailBlob)
      || Boolean(task.file && Number(task.file.size || 0) > 0);
    const retry = retryRequested && hasRetrySource;
    verificationPhotoRetryCandidate = retry ? verificationPhotoRetryFromTask(task) : null;
    const title = outcome === "success" ? `${photoSlotLabel(task.slot)}上传成功` : outcome === "canceled" ? "上传已取消" : "照片上传失败";
    const finalDetail = retryRequested && !hasRetrySource && task.source === "camera"
      ? `${detail} 拍摄画面未完成处理，请重新拍照。`
      : detail;
    setVerificationPhotoTaskStage(task, outcome.toUpperCase(), title, finalDetail, outcome === "success" ? 100 : 0, {
      canCancel: false,
      canRetry: retry,
      progressText: outcome === "success" ? "100%" : outcome === "canceled" ? "已取消" : "未完成",
      error: outcome === "failed"
    });
    setVerificationPhotoButtonsDisabled(false);
    if (outcome === "success") scheduleVerificationPhotoTaskDismiss();
    const manifestReady = verificationPhotoManifestReady();
    setExportControls(Boolean(currentRecord) && manifestReady, manifestReady
      ? (outcome === "success" ? "照片已保存，可以导出完整工单。" : "照片任务已结束，可以导出当前完整工单。")
      : "照片清单读取失败，暂时不能导出完整工单。");
    if (options.refresh !== false) verificationPhotoLoadPromise = refreshVerificationPhotosSilently(task.recordId);
  }

  async function refreshVerificationPhotosSilently(recordId) {
    if (!/^\d+$/.test(clean(recordId)) || !$("verificationPhotoPanel")) return null;
    const request = ++verificationPhotoRequest;
    try {
      const payload = await callVerificationPhotoRead({ action: "getVerificationPhotos", recordId });
      if (request !== verificationPhotoRequest) return null;
      renderVerificationPhotos(mergeVerificationPhotoLocalPreviews(payload, recordId), recordId);
      setVerificationPhotoButtonsDisabled(verificationPhotoUploadBusy);
      promoteUsableVerificationPhotoPreviews(payload, recordId, request);
      return payload;
    } catch (_) {
      return null;
    }
  }

  function applyCommittedVerificationPhoto(task, payload) {
    if (!task.prepared || !currentVerificationPhotoPayload) return;
    const photos = Array.isArray(currentVerificationPhotoPayload.photos) ? [...currentVerificationPhotoPayload.photos] : [];
    revokeVerificationPhotoLocalPreview(task.slot);
    const thumbnailUrl = URL.createObjectURL(task.prepared.thumbnailBlob);
    const originalUrl = URL.createObjectURL(task.prepared.originalBlob);
    const serverPhoto = payload?.photo && typeof payload.photo === "object" ? payload.photo : {};
    const photo = {
      ...serverPhoto,
      slot: task.slot,
      thumbnailUrl,
      originalUrl,
      originalUrlExpiresAt: Number.MAX_SAFE_INTEGER,
      localPreview: true,
      originalBytes: Number(serverPhoto.originalBytes || task.prepared.originalBlob.size),
      thumbnailBytes: Number(serverPhoto.thumbnailBytes || task.prepared.thumbnailBlob.size),
      width: Number(serverPhoto.width || task.prepared.imageWidth),
      height: Number(serverPhoto.height || task.prepared.imageHeight),
      uploadedAt: serverPhoto.uploadedAt || new Date().toISOString()
    };
    verificationPhotoLocalPreviews.set(Number(task.slot), {
      recordId: clean(task.recordId),
      thumbnailUrl,
      originalUrl,
      photo,
      remoteProbe: null,
      remoteProbeUrl: ""
    });
    const next = photos.filter((item) => Number(item.slot) !== task.slot);
    next.push(photo);
    next.sort((left, right) => Number(left.slot) - Number(right.slot));
    renderVerificationPhotos(mergeVerificationPhotoLocalPreviews({ ...currentVerificationPhotoPayload, photos: next }, task.recordId), task.recordId);
    setVerificationPhotoButtonsDisabled(true);
  }

  async function reconcileVerificationPhotoCancellation(task, outcome = "canceled", failure = null) {
    if (outcome === "failed") {
      task.reconcileOutcome = "failed";
      task.reconcileFailure = failure;
    }
    outcome = task.reconcileOutcome || outcome;
    failure = task.reconcileFailure || failure;
    if (task.cancelPromise) return task.cancelPromise;
    task.cancelPromise = (async () => {
      const cancelingCopy = verificationPhotoCancellationCopy(outcome, failure);
      setVerificationPhotoTaskStage(task, outcome === "failed" ? "RECOVERING" : "CANCELING", cancelingCopy.title, cancelingCopy.detail, task.progress, {
        cancelDisabled: true,
        cancelLabel: cancelingCopy.cancelLabel,
        indeterminate: true,
        progressText: cancelingCopy.progressText,
        error: outcome === "failed"
      });
      task.worker?.terminate?.();
      task.cancelPreparation?.();
      task.cancelPreparation = null;
      task.worker = null;
      task.xhrs.forEach((xhr) => { try { xhr.abort(); } catch (_) { /* 已结束 */ } });
      let latest = null;
      let cancelNotFound = false;
      let statusNotFound = false;
      const cancellationRecordId = clean(task.cancelRecordId || task.recordId);
      try { latest = await callVerificationPhotoLifecycle({ action: "cancelVerificationPhotoUpload", recordId: cancellationRecordId, requestId: task.requestId }); }
      catch (error) { cancelNotFound = verificationPhotoUploadRequestNotFound(error); }
      for (let attempt = 0; attempt < 6 && !verificationPhotoUploadTerminal(verificationPhotoUploadStatus(latest)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 250));
        try { latest = await callVerificationPhotoLifecycle({ action: "getVerificationPhotoUploadStatus", recordId: cancellationRecordId, requestId: task.requestId }, 6000); }
        catch (error) {
          if (clean(error?.code).toUpperCase() === "PHOTO_UPLOAD_CONFIRM_TIMEOUT") break;
          statusNotFound = verificationPhotoUploadRequestNotFound(error);
          if (cancelNotFound && statusNotFound) break;
        }
      }
      const status = verificationPhotoUploadStatus(latest);
      if (cancelNotFound && statusNotFound) {
        if (task.beginInFlight) {
          setVerificationPhotoTaskStage(task, "CANCELING", "停止请求已收到", "网络仍在处理最初的上传连接。请稍候几秒后再次确认；确认前不会开始下一张。", task.progress, {
            cancelDisabled: false,
            cancelLabel: "再次确认",
            indeterminate: true,
            progressText: "待确认"
          });
          task.cancelPromise = null;
          return;
        }
        finishVerificationPhotoTask(task, outcome, outcome === "failed"
          ? (failure?.message || "服务器未建立照片任务，可重新上传。")
          : "服务器确认没有该上传任务；已安全取消，可重新上传。", { refresh: false });
        return;
      }
      if (["COMMITTED", "COMPLETED"].includes(status)) {
        if (task.remoteConflict) {
          finishVerificationPhotoTask(task, "canceled", "已有上传任务已经完成；本次所选照片尚未上传，可点击“重新上传”。", { refresh: true });
        } else {
          if (latest?.photo) applyCommittedVerificationPhoto(task, latest);
          finishVerificationPhotoTask(task, "success", "取消指令到达时服务器已经完成保存；页面已按最终结果同步。", { refresh: true });
        }
        return;
      }
      if (verificationPhotoUploadTerminal(status)) {
        finishVerificationPhotoTask(task, outcome, outcome === "failed" ? (failure?.message || "照片上传失败，可重试") : "服务器已确认取消；可重新上传本张照片。", { refresh: true });
        return;
      }
      setVerificationPhotoTaskStage(task, outcome === "failed" ? "RECOVERING" : "CANCELING", outcome === "failed" ? "上传恢复尚未完成" : "还在确认上传已停止", outcome === "failed"
        ? `${clean(failure?.message) || "照片没有上传完成"}；网络响应较慢。为防止旧照片稍后覆盖新照片，请检查网络后再次确认。`
        : "网络响应较慢。为防止旧照片稍后覆盖新照片，请先确认这次上传已经停止，再上传下一张。", task.progress, {
        cancelDisabled: false,
        cancelLabel: "再次确认",
        indeterminate: true,
        progressText: "待确认",
        error: true
      });
      task.cancelPromise = null;
    })();
    return task.cancelPromise;
  }

  async function monitorExistingVerificationPhotoUpload(task) {
    setVerificationPhotoTaskStage(task, "WAITING", "检测到已有照片上传", "另一标签页或设备的上传尚未结束；不会自动取消。正在读取其状态…", 25, {
      cancelDisabled: false,
      cancelLabel: "取消已有任务"
    });
    let latest = null;
    for (let attempt = 0; attempt < 6 && verificationPhotoUploadTask === task && !task.cancelRequested; attempt += 1) {
      try {
        latest = await callVerificationPhotoLifecycle({
          action: "getVerificationPhotoUploadStatus",
          recordId: clean(task.cancelRecordId || task.recordId),
          requestId: task.requestId
        }, 6000);
      } catch (error) {
        if (clean(error?.code).toUpperCase() === "PHOTO_UPLOAD_CONFIRM_TIMEOUT") break;
        if (verificationPhotoUploadRequestNotFound(error)) {
          finishVerificationPhotoTask(task, "canceled", "已有上传任务已结束；本次所选照片尚未上传，可点击“重新上传”。", { refresh: true });
          return;
        }
      }
      if (verificationPhotoUploadTerminal(verificationPhotoUploadStatus(latest))) {
        finishVerificationPhotoTask(task, "canceled", "已有上传任务已结束；本次所选照片尚未上传，可点击“重新上传”。", { refresh: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 650 + attempt * 250));
    }
    if (verificationPhotoUploadTask !== task || task.cancelRequested) return;
    setVerificationPhotoTaskStage(task, "WAITING", "已有上传仍在进行", "为防止两个任务互相覆盖，请等待它完成；如确认不再需要，可点击“取消已有任务”。", 25, {
      cancelDisabled: false,
      cancelLabel: "取消已有任务"
    });
  }

  async function cancelVerificationPhotoUpload() {
    const task = verificationPhotoUploadTask;
    if (!task) return;
    task.cancelRequested = true;
    task.cancelPreparation?.();
    task.cancelPreparation = null;
    task.worker?.terminate?.();
    task.worker = null;
    task.xhrs.forEach((xhr) => { try { xhr.abort(); } catch (_) { /* 已结束 */ } });
    if (task.beginInFlight) {
      setVerificationPhotoTaskStage(task, "CANCELING", "正在停止上传", "停止请求已经收到。出现“已取消”后，就可以重新拍照或选择文件。", task.progress, {
        cancelDisabled: true,
        cancelLabel: "正在停止…",
        indeterminate: true,
        progressText: "停止中"
      });
      await reconcileVerificationPhotoCancellation(task, task.reconcileOutcome || "canceled", task.reconcileFailure || null);
      return;
    }
    if (!task.intentStarted && !task.beginDispatched) {
      finishVerificationPhotoTask(task, "canceled", "已在照片离开设备前取消；可重新上传。", { refresh: false });
      return;
    }
    await reconcileVerificationPhotoCancellation(task, task.reconcileOutcome || "canceled", task.reconcileFailure || null);
  }

  async function runVerificationPhotoUpload(task, sourceCanvas = null) {
    try {
      setVerificationPhotoTaskStage(task, "PREPARING", `正在处理${photoSlotLabel(task.slot)}`, "在设备后台校正方向、生成高清图和预览图…", 8);
      task.prepared = await prepareVerificationPhoto(task.file, task, sourceCanvas);
      assertVerificationPhotoTask(task);
      if (!task.prepared?.originalBlob || !task.prepared?.thumbnailBlob) throw new Error("照片处理结果无效");
      setVerificationPhotoTaskStage(task, "AUTHORIZING", "正在申请安全上传", "正在验证提交人身份、24 小时修改期限和照片位置…", 25);
      let begin;
      task.beginDispatched = true;
      task.beginInFlight = true;
      const beginSlowTimer = setTimeout(() => {
        if (verificationPhotoUploadTask !== task || !task.beginInFlight || task.cancelRequested) return;
        setVerificationPhotoTaskStage(task, "AUTHORIZING", "网络较慢，仍在连接", "照片还没有开始传输。可以继续等待，或点击“取消上传”。", task.progress, {
          indeterminate: true,
          progressText: "连接中"
        });
      }, 8000);
      try {
        begin = await callVerificationPhoto({
          action: "beginVerificationPhotoUpload",
          recordId: task.recordId,
          slot: task.slot,
          requestId: task.requestId,
          originalBytes: task.prepared.originalBlob.size
        });
      } catch (error) {
        if (clean(error?.code).toUpperCase() === "PHOTO_UPLOAD_ALREADY_ACTIVE") {
          const activeRequest = error?.payload?.activeRequest && typeof error.payload.activeRequest === "object" ? error.payload.activeRequest : {};
          const activeRequestId = clean(activeRequest.requestId || error?.payload?.requestId || error?.payload?.activeRequestId);
          if (!activeRequestId) throw error;
          task.requestId = activeRequestId;
          task.cancelRecordId = clean(activeRequest.recordId || task.recordId);
          task.intentStarted = true;
          task.remoteConflict = true;
          task.beginInFlight = false;
          return await monitorExistingVerificationPhotoUpload(task);
        }
        if (directVerificationPhotoUploadUnavailable(error)) {
          task.beginDispatched = false;
          throw verificationPhotoUploadError("新版照片上传服务尚未部署，请先执行迁移 039、部署 verificationPhoto v1，并将 faceRecognition 更新到 v53。", "PHOTO_UPLOAD_DIRECT_UNAVAILABLE");
        }
        throw error;
      } finally {
        clearTimeout(beginSlowTimer);
        task.beginInFlight = false;
      }
      if (clean(begin?.requestId) && clean(begin.requestId) !== task.requestId) {
        throw verificationPhotoUploadError("服务器上传任务编号不一致，已停止上传", "PHOTO_UPLOAD_REQUEST_MISMATCH");
      }
      if (!task.requestId) {
        throw verificationPhotoUploadError("服务器没有返回有效的安全上传任务", "PHOTO_UPLOAD_INTENT_INVALID");
      }
      task.intentStarted = true;
      if (begin?.alreadyCommitted === true || verificationPhotoUploadStatus(begin) === "COMMITTED") {
        finishVerificationPhotoTask(task, "success", `${photoSlotLabel(task.slot)}已经安全保存；照片列表正在刷新。`, { refresh: true });
        return;
      }
      if (task.cancelRequested) return await reconcileVerificationPhotoCancellation(task, "canceled");
      const uploadMode = clean(begin?.uploadMode).toUpperCase() || "DIRECT";
      let committed;
      if (uploadMode === "FUNCTION") {
        setVerificationPhotoTaskStage(task, "UPLOADING", "正在上传这一张照片", "独立照片服务正在安全保存，请保持页面开启；完成后才能上传下一张。", 0, {
          indeterminate: true,
          progressText: "上传中"
        });
        const imageBase64 = await verificationPhotoBlobDataUrl(task.prepared.originalBlob);
        assertVerificationPhotoTask(task);
        committed = await callVerificationPhoto({
          action: "commitVerificationPhotoUpload",
          recordId: task.recordId,
          requestId: task.requestId,
          functionUploadProof: clean(begin?.functionUploadProof),
          imageBase64
        });
      } else {
        if (uploadMode !== "DIRECT" || !signedUploadTarget(begin?.originalUpload)?.url) {
          throw verificationPhotoUploadError("服务器没有返回有效的安全上传地址", "PHOTO_UPLOAD_INTENT_INVALID");
        }
        task.uploadParts = {};
        const uploads = [uploadVerificationPhotoBlob(task, "高清原图", begin.originalUpload, task.prepared.originalBlob)];
        if (signedUploadTarget(begin.thumbnailUpload)?.url) uploads.push(uploadVerificationPhotoBlob(task, "预览图", begin.thumbnailUpload, task.prepared.thumbnailBlob));
        await Promise.all(uploads);
        assertVerificationPhotoTask(task);
        setVerificationPhotoTaskStage(task, "COMMITTING", "上传完成，正在安全入库", "正在校验照片完整性并绑定到核销单…", 90, { cancelLabel: "取消并核对" });
        committed = await callVerificationPhoto({
          action: "commitVerificationPhotoUpload",
          recordId: task.recordId,
          requestId: task.requestId
        });
      }
      if (task.cancelRequested) return await reconcileVerificationPhotoCancellation(task, "canceled");
      applyCommittedVerificationPhoto(task, committed);
      finishVerificationPhotoTask(task, "success", `${photoSlotLabel(task.slot)}已安全保存；可继续上传下一张。`, { refresh: true });
    } catch (error) {
      if (verificationPhotoUploadTask !== task) return;
      if (task.cancelRequested || isVerificationPhotoUploadCanceled(error)) {
        if (task.intentStarted || task.beginDispatched) await reconcileVerificationPhotoCancellation(task, "canceled");
        else finishVerificationPhotoTask(task, "canceled", "上传已取消，可重新上传。", { refresh: false });
        return;
      }
      if (task.intentStarted || task.beginDispatched) {
        task.cancelRequested = true;
        await reconcileVerificationPhotoCancellation(task, "failed", error);
        return;
      }
      finishVerificationPhotoTask(task, "failed", error?.message || "照片上传失败，请重试", { refresh: false });
    }
  }

  async function uploadVerificationPhoto(recordId, slot, file, options = {}) {
    if (verificationPhotoUploadBusy) {
      updateVerificationPhotoTaskUi(verificationPhotoUploadTask, { detail: "请等待当前照片成功，或先取消当前任务，再上传下一张。" });
      return;
    }
    if (orderExportBusy) {
      $("verificationPhotoMessage").className = "verification-photo-message error";
      $("verificationPhotoMessage").textContent = "工单正在导出，请等待完成后再上传照片。";
      return;
    }
    verificationPhotoUploadBusy = true;
    const task = {
      id: ++verificationPhotoTaskSequence,
      recordId: clean(recordId),
      slot: Number(slot),
      file,
      prepared: options.prepared || null,
      source: options.source || "library",
      state: "PREPARING",
      progress: 0,
      cancelRequested: false,
      requestId: "",
      beginDispatched: false,
      beginInFlight: false,
      intentStarted: false,
      xhrs: new Set(),
      uploadParts: {}
    };
    task.requestId = `vp_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(3)).reduce((text, value) => text + value.toString(36).padStart(7, "0"), "")}`.slice(0, 64);
    verificationPhotoUploadTask = task;
    verificationPhotoRetryCandidate = null;
    setVerificationPhotoButtonsDisabled(true);
    setExportControls(false, "照片正在上传，保存完成后才能导出完整工单。");
    await runVerificationPhotoUpload(task, options.sourceCanvas || null);
  }

  function chooseVerificationPhoto(recordId, slot) {
    if (verificationPhotoUploadBusy) {
      updateVerificationPhotoTaskUi(verificationPhotoUploadTask, { detail: "一次只能上传一张；请等待成功，或取消当前任务。" });
      return;
    }
    const input = $("verificationPhotoFileInput");
    if (!input) return;
    input.value = "";
    input.dataset.recordId = clean(recordId);
    input.dataset.slot = String(slot);
    input.setAttribute("aria-label", `从相册或文件中选择${photoSlotLabel(slot)}`);
    input.click();
  }

  function handleVerificationPhotoFileSelected(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    uploadVerificationPhoto(clean(input.dataset.recordId), Number(input.dataset.slot), file, { source: "library" });
  }

  function retryVerificationPhotoUpload() {
    const candidate = verificationPhotoRetryCandidate;
    if (!candidate || verificationPhotoUploadBusy) return;
    uploadVerificationPhoto(candidate.recordId, candidate.slot, candidate.file, {
      source: candidate.source,
      prepared: candidate.prepared
    });
  }

  function releaseVerificationPhotoCameraStream() {
    verificationCameraStream?.getTracks?.().forEach((track) => track.stop());
    verificationCameraStream = null;
    const video = $("verificationPhotoCameraVideo");
    if (video) {
      video.srcObject = null;
      video.classList.remove("is-user-facing");
    }
  }

  function stopVerificationPhotoCamera(clearTarget = true) {
    verificationCameraRequest += 1;
    verificationCameraSwitchBusy = false;
    releaseVerificationPhotoCameraStream();
    const capture = $("captureVerificationPhotoCamera");
    if (capture) capture.disabled = true;
    const cameraSwitch = $("switchVerificationPhotoCamera");
    if (cameraSwitch) {
      cameraSwitch.disabled = true;
      cameraSwitch.textContent = "切换摄像头";
      cameraSwitch.setAttribute("aria-label", "切换前后摄像头");
    }
    const placeholder = $("verificationPhotoCameraPlaceholder");
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.textContent = "正在开启摄像头…";
    }
    if (clearTarget) verificationCameraTarget = null;
  }

  function verificationCameraConstraint(facingMode, exact = false) {
    return {
      video: {
        facingMode: exact ? { exact: facingMode } : { ideal: facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };
  }

  async function verificationCameraCount() {
    if (typeof navigator.mediaDevices?.enumerateDevices !== "function") return null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === "videoinput").length;
    } catch (_) {
      return null;
    }
  }

  function verificationCameraName(facingMode) {
    return facingMode === "user" ? "前置摄像头" : "后置摄像头";
  }

  function nextVerificationCameraFacingMode(facingMode) {
    return facingMode === "user" ? "environment" : "user";
  }

  async function startVerificationPhotoCamera(facingMode, exact = false) {
    const dialog = $("verificationPhotoCameraDialog");
    const video = $("verificationPhotoCameraVideo");
    const message = $("verificationPhotoCameraMessage");
    const placeholder = $("verificationPhotoCameraPlaceholder");
    const capture = $("captureVerificationPhotoCamera");
    const cameraSwitch = $("switchVerificationPhotoCamera");
    if (!dialog || !dialog.open || !verificationCameraTarget || !video || !message || !placeholder || !capture || !cameraSwitch) return false;
    const request = ++verificationCameraRequest;
    releaseVerificationPhotoCameraStream();
    capture.disabled = true;
    cameraSwitch.disabled = true;
    placeholder.hidden = false;
    placeholder.textContent = `正在开启${verificationCameraName(facingMode)}…`;
    message.className = "verification-photo-camera-message";
    message.textContent = `正在请求${verificationCameraName(facingMode)}。`;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(verificationCameraConstraint(facingMode, exact));
      if (request !== verificationCameraRequest || !dialog.open) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      verificationCameraStream = stream;
      const activeFacingMode = clean(stream.getVideoTracks?.()[0]?.getSettings?.().facingMode).toLowerCase();
      verificationCameraFacingMode = ["user", "environment"].includes(activeFacingMode) ? activeFacingMode : facingMode;
      video.classList.toggle("is-user-facing", verificationCameraFacingMode === "user");
      video.srcObject = stream;
      await video.play();
      if (request !== verificationCameraRequest || !dialog.open) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      placeholder.hidden = true;
      capture.disabled = false;
      const nextFacingMode = nextVerificationCameraFacingMode(verificationCameraFacingMode);
      cameraSwitch.textContent = `切换到${nextFacingMode === "user" ? "前置" : "后置"}`;
      cameraSwitch.setAttribute("aria-label", `切换到${verificationCameraName(nextFacingMode)}`);
      const cameraCount = await verificationCameraCount();
      if (request !== verificationCameraRequest || !dialog.open) return false;
      const confirmedSingleCamera = cameraCount === 1 && !usesMobilePhotoLibrary();
      cameraSwitch.disabled = confirmedSingleCamera;
      message.textContent = confirmedSingleCamera
        ? `${verificationCameraName(verificationCameraFacingMode)}已开启；当前设备只检测到一个摄像头。`
        : `${verificationCameraName(verificationCameraFacingMode)}已开启，可拍摄或切换前后摄像头。`;
      return true;
    } catch (error) {
      if (request !== verificationCameraRequest || !dialog.open) return false;
      releaseVerificationPhotoCameraStream();
      placeholder.hidden = false;
      placeholder.textContent = "摄像头开启失败";
      message.className = "verification-photo-camera-message error";
      message.textContent = error?.name === "NotAllowedError"
        ? "未获得摄像头权限。请在浏览器设置中允许摄像头，或使用“上传文件”从相册选择。"
        : exact && error?.name === "OverconstrainedError"
        ? `当前设备没有可用的${verificationCameraName(facingMode)}。`
        : "无法使用摄像头。请检查设备摄像头，或使用“上传文件”从相册选择。";
      return false;
    }
  }

  async function openVerificationPhotoCamera(recordId, slot) {
    const dialog = $("verificationPhotoCameraDialog");
    const video = $("verificationPhotoCameraVideo");
    const message = $("verificationPhotoCameraMessage");
    const placeholder = $("verificationPhotoCameraPlaceholder");
    if (!dialog || !video || !message || !placeholder) return;
    stopVerificationPhotoCamera();
    verificationCameraTarget = { recordId, slot };
    verificationCameraFacingMode = "environment";
    $("verificationPhotoCameraTitle").textContent = `拍摄${photoSlotLabel(slot)}`;
    message.className = "verification-photo-camera-message";
    message.textContent = "请允许浏览器使用摄像头；优先开启后置摄像头。";
    if (!dialog.open) dialog.showModal();
    if (!navigator.mediaDevices?.getUserMedia) {
      placeholder.textContent = "当前浏览器无法直接开启摄像头";
      message.className = "verification-photo-camera-message error";
      message.textContent = "请关闭窗口，使用“上传文件”从手机或 iPad 相册选择照片。";
      return;
    }
    await startVerificationPhotoCamera("environment");
  }

  async function switchVerificationPhotoCamera() {
    if (verificationCameraSwitchBusy || !verificationCameraTarget || !verificationCameraStream) return;
    verificationCameraSwitchBusy = true;
    const dialog = $("verificationPhotoCameraDialog");
    const target = verificationCameraTarget;
    const previousFacingMode = verificationCameraFacingMode;
    const nextFacingMode = nextVerificationCameraFacingMode(previousFacingMode);
    const message = $("verificationPhotoCameraMessage");
    try {
      let switched = await startVerificationPhotoCamera(nextFacingMode, true);
      if (!dialog?.open || verificationCameraTarget !== target) return;
      if (!switched) switched = await startVerificationPhotoCamera(nextFacingMode);
      if (!dialog?.open || verificationCameraTarget !== target) return;
      if (switched && verificationCameraFacingMode === nextFacingMode) return;
      if (switched) {
        if (message) {
          message.className = "verification-photo-camera-message error";
          message.textContent = `浏览器仍在使用${verificationCameraName(previousFacingMode)}；当前设备可能不支持网页切换摄像头。`;
        }
        return;
      }
      const restored = await startVerificationPhotoCamera(previousFacingMode);
      if (restored && message) {
        message.className = "verification-photo-camera-message error";
        message.textContent = `未检测到可用的${verificationCameraName(nextFacingMode)}，已恢复${verificationCameraName(previousFacingMode)}。`;
      }
    } finally {
      if (verificationCameraTarget === target) verificationCameraSwitchBusy = false;
    }
  }

  async function captureVerificationPhotoCamera() {
    const target = verificationCameraTarget;
    const video = $("verificationPhotoCameraVideo");
    const canvas = $("verificationPhotoCameraCanvas");
    const capture = $("captureVerificationPhotoCamera");
    const message = $("verificationPhotoCameraMessage");
    const width = Number(video?.videoWidth || 0);
    const height = Number(video?.videoHeight || 0);
    if (!target || !canvas || !width || !height || verificationPhotoUploadBusy || verificationCameraSwitchBusy) {
      if (message) {
        message.className = "verification-photo-camera-message error";
        message.textContent = "摄像头画面尚未准备好，请稍后再试。";
      }
      return;
    }
    capture.disabled = true;
    message.className = "verification-photo-camera-message";
    message.textContent = "正在保存拍摄画面…";
    try {
      const scale = Math.min(1, 2400 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
      $("verificationPhotoCameraDialog").close();
      await uploadVerificationPhoto(target.recordId, target.slot, null, { source: "camera", sourceCanvas: canvas });
    } catch (error) {
      capture.disabled = false;
      message.className = "verification-photo-camera-message error";
      message.textContent = error?.message || "拍摄失败，请重试";
    }
  }

  async function showVerificationPhotoOriginal(url, listPhoto, request) {
    const dialog = $("verificationPhotoViewer");
    const image = $("verificationPhotoOriginal");
    if (!dialog || !image || !url) return false;
    await waitForVerificationPhotoPreload(url, listPhoto);
    if (request !== verificationPhotoViewerRequest || !dialog.open) return false;
    image.dataset.photoQuality = "original";
    if (image.src !== url) image.src = url;
    return true;
  }

  function revokeVerificationPhotoViewerFallback() {
    const url = verificationPhotoViewerFallbackUrl;
    verificationPhotoViewerFallbackUrl = "";
    if (!url) return;
    verificationPhotoPreloads.delete(url);
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  async function openVerificationPhoto(recordId, slot) {
    const dialog = $("verificationPhotoViewer");
    const image = $("verificationPhotoOriginal");
    if (!dialog || !image) return;
    const request = ++verificationPhotoViewerRequest;
    const listPhoto = (currentVerificationPhotoPayload?.photos || []).find((photo) => Number(photo.slot) === slot);
    const cachedOriginalUrl = clean(listPhoto?.originalUrl);
    const cachedUrlValid = cachedOriginalUrl && Number(listPhoto?.originalUrlExpiresAt || 0) > Date.now() + 10000;
    const status = $("verificationPhotoViewerStatus");
    revokeVerificationPhotoViewerFallback();
    image.fetchPriority = "high";
    resetVerificationPhotoViewerTransform();
    $("verificationPhotoViewerTitle").textContent = cachedUrlValid
      ? `${photoSlotLabel(slot)} · ${listPhoto?.width || "—"} × ${listPhoto?.height || "—"}`
      : `${photoSlotLabel(slot)} · 正在加载高清原图`;
    if (status) status.textContent = "先显示缩略图，高清原图加载完成后自动替换；可双指、滚轮或按钮放大。";
    image.removeAttribute("src");
    image.alt = `${photoSlotLabel(slot)}原图`;
    image.onload = () => {
      if (request !== verificationPhotoViewerRequest || !dialog.open || !status) return;
      applyVerificationPhotoViewerTransform();
      status.textContent = image.dataset.photoQuality === "original"
        ? "高清原图已加载，可双指缩放、滚轮缩放或拖动查看。"
        : "缩略图已显示，高清原图仍在加载…";
    };
    image.onerror = () => {
      if (request === verificationPhotoViewerRequest && dialog.open && status) status.textContent = "正在重新获取高清原图地址…";
    };
    if (clean(listPhoto?.thumbnailUrl)) {
      image.dataset.photoQuality = "thumbnail";
      image.src = listPhoto.thumbnailUrl;
    }
    dialog.showModal();
    $("verificationPhotoOriginalFrame")?.focus({ preventScroll: true });
    const auditKey = `${recordId}:${slot}:${clean(listPhoto?.uploadedAt)}`;
    const cachedLoadPromise = cachedUrlValid
      ? showVerificationPhotoOriginal(cachedOriginalUrl, listPhoto, request).catch(() => false)
      : Promise.resolve(false);
    if (cachedUrlValid && verificationPhotoOriginalAuditCache.has(auditKey) && await cachedLoadPromise) return;
    try {
      const payload = await refreshVerificationPhotoOriginalUrl(recordId, slot, listPhoto);
      if (request !== verificationPhotoViewerRequest || !dialog.open) return;
      const cachedDisplayed = await cachedLoadPromise;
      if (!cachedDisplayed || payload.photoUrl !== cachedOriginalUrl) await showVerificationPhotoOriginal(payload.photoUrl, listPhoto, request);
      if (request !== verificationPhotoViewerRequest || !dialog.open) return;
      verificationPhotoOriginalAuditCache.add(auditKey);
      $("verificationPhotoViewerTitle").textContent = `${photoSlotLabel(slot)} · ${payload.width || "—"} × ${payload.height || "—"}`;
    } catch (error) {
      if (request !== verificationPhotoViewerRequest || !dialog.open) return;
      const cachedDisplayed = await cachedLoadPromise;
      if (cachedDisplayed) {
        if (status) status.textContent = "高清原图已显示；临时地址刷新暂不可用。";
        return;
      }
      if (status) status.textContent = "临时访问地址暂不可用，正在通过安全通道取回高清原图…";
      try {
        const blob = await fetchVerificationPhotoExportFallback(recordId, slot);
        if (request !== verificationPhotoViewerRequest || !dialog.open) return;
        const fallbackUrl = URL.createObjectURL(blob);
        verificationPhotoViewerFallbackUrl = fallbackUrl;
        const displayed = await showVerificationPhotoOriginal(fallbackUrl, {
          ...listPhoto,
          originalBytes: blob.size
        }, request);
        if (!displayed || request !== verificationPhotoViewerRequest || !dialog.open) return;
        verificationPhotoOriginalAuditCache.add(auditKey);
        $("verificationPhotoViewerTitle").textContent = `${photoSlotLabel(slot)} · ${listPhoto?.width || "—"} × ${listPhoto?.height || "—"}`;
        if (status) status.textContent = "高清原图已通过安全通道加载，可双指缩放、滚轮缩放或拖动查看。";
      } catch (fallbackError) {
        if (request !== verificationPhotoViewerRequest || !dialog.open) return;
        $("verificationPhotoViewerTitle").textContent = fallbackError?.message || error?.message || "原图读取失败";
        if (status) status.textContent = "高清原图读取失败，请关闭后重试。";
      }
    }
  }

  function recordFromQuery(recordId) {
    const kind = first(params.get("kind"), type === "recharge" ? "新充值" : "正常核销");
    return {
      id: recordId,
      recordCode: recordId,
      applicationType: type === "recharge" ? kind : "",
      verificationType: type === "verification" ? kind : "",
      status: first(params.get("status"), "PENDING"),
      storeId: params.get("storeId"),
      storeName: params.get("storeName"),
      storeAddress: params.get("storeAddress"),
      customerId: params.get("customerId"),
      customerName: params.get("customerName"),
      projectId: params.get("projectId"),
      projectCode: params.get("projectCode"),
      projectName: params.get("projectName"),
      teacherId: params.get("teacherId"),
      teacherCode: params.get("teacherCode"),
      teacherName: params.get("teacherName"),
      count: params.get("count"),
      createdAt: params.get("submittedAt"),
      reviewedAt: params.get("reviewedAt"),
      note: params.get("note"),
      reviewNote: params.get("reviewNote")
    };
  }

  function renderMissing(recordId) {
    currentRecord = null;
    currentVerificationPhotoPayload = null;
    currentProductTemplate = null;
    currentProductTemplateError = null;
    productTemplateLoadPromise = Promise.resolve();
    clearProductReceiptLogoObjectUrl();
    verificationPhotoLoadPromise = Promise.resolve();
    setExportControls(false, "工单读取完成后可以导出。");
    const recharge = type === "recharge";
    $("orderKindTag").textContent = recharge ? "充值" : "核销";
    $("orderTitle").textContent = `${recharge ? "充值单" : "核销单"} ${recordId || "—"}`;
    $("orderDescription").textContent = "未找到该工单的数据，请返回查询页面后重新进入。";
    $("orderStatus").className = "rejected";
    $("orderStatus").textContent = "读取失败";
    $("orderStatusHint").textContent = "当前页面没有收到工单数据";
    const missingFacts = ["门店", "客户", "项目", "业务老师"];
    if (!recharge) missingFacts.push("提交时间");
    $("orderKeyfacts").innerHTML = missingFacts.map((label) => factCard(label, "", "")).join("");
    if (recharge) $("orderInfo").innerHTML = infoCard("充值单编号", recordId);
    if (!recharge) {
      renderVerificationMessages(null);
      resetVerificationPhotoPanel("尚未读取到可关联的数据库核销单。");
      return;
    }
    $("reviewStatusRow").hidden = false;
    $("reviewStatus").textContent = "—";
    renderRechargeReviewMessages(null);
  }

  function renderRecord(record) {
    currentRecord = record;
    productTemplateLoadPromise = loadProductReceiptTemplate(record);
    productTemplateLoadPromise.catch(() => {});
    const recharge = type === "recharge";
    const recordCode = first(record.recordCode, record.rechargeCode, record.verificationCode, record.id);
    const normalKind = recharge
      ? first(record.originalKind, record.applicationType, record.rechargeType, "新充值")
      : first(record.originalKind, record.verificationType, record.applicationType, "正常核销");
    const kind = normalKind;
    const refund = recharge && first(record.originalType, record.rechargeType).toUpperCase() === "REFUND";
    const originalStatusCode = String(record.status || record.recordStatus || "").toUpperCase();
    const status = statusView(originalStatusCode);
    if (recharge && originalStatusCode === "VOIDED") {
      status.hint = record.balanceRestored === false
        ? "作废审核已通过；原单尚未生效，客户次数无需恢复"
        : "作废审核已通过，客户次数已恢复";
    }
    const storeCode = first(record.storeCode, record.storeId);
    const customerCode = first(record.customerCode, record.customerId);
    const projectCode = first(record.projectCode, record.productCode, record.projectId, record.productId);
    const teacherCode = first(record.teacherCode, record.teacherId);
    const submittedAt = formatTime(first(record.createdAt, record.submittedAt));
    const reviewedAt = formatTime(first(record.reviewedAt, record.approvedAt, record.rejectedAt));
    const countNumber = Number(first(record.count, record.unitCount, recharge ? "0" : "1"));
    const rechargeCountLabel = Number.isFinite(countNumber) && countNumber > 0 ? `${countNumber} 次` : "—";
    const description = `门店详细地址：${fullStoreAddress(record) || "未填写"}`;

    $("orderKindTag").textContent = kind;
    $("orderTitle").textContent = `${refund ? "退费单" : recharge ? "充值单" : "核销单"} ${recordCode || "—"}`;
    $("orderDescription").textContent = description;
    $("orderStatus").className = status.className;
    $("orderStatus").textContent = status.label;
    $("orderStatusHint").textContent = status.hint;

    const keyFacts = [
      factCard("门店", record.storeName, storeCode),
      factCard("客户", record.customerName, customerCode),
      factCard("项目", first(record.projectName, record.productName), projectCode),
      factCard("业务老师", record.teacherName, teacherCode, "未指定")
    ];
    if (!recharge) keyFacts.push(factCard("提交时间", submittedAt, ""));
    $("orderKeyfacts").innerHTML = keyFacts.join("");

    if (recharge) {
      const items = refund
        ? [["退费次数", rechargeCountLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]]
        : [["充值次数", rechargeCountLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]];
      $("orderInfo").innerHTML = items.map(([label, value]) => infoCard(label, value)).join("");
    }

    if (!recharge) {
      renderVerificationMessages(record);
      verificationPhotoLoadPromise = loadVerificationPhotos(record);
      setExportControls(true, "可导出完整工单；导出时会按权限读取高清照片。");
      return;
    }

    const detailPanel = document.querySelector(".verification-order-details");
    if (detailPanel) {
      const heading = detailPanel.querySelector("h2");
      const badge = detailPanel.querySelector(".badge");
      if (heading) heading.textContent = refund ? "退费信息" : "充值信息";
      if (badge) badge.textContent = refund ? "退费" : "充值";
    }

    $("reviewStatus").textContent = status.label;
    $("reviewStatusRow").hidden = false;
    renderRechargeReviewMessages(record);
    setExportControls(true, `可导出完整${refund ? "退费" : "充值"}工单。`);
  }

  function voidActionUnavailableReason(record, voidStarted) {
    const originalStatus = String(record?.status || record?.recordStatus || "").toUpperCase();
    const voidStatus = String(record?.voidStatus || record?.voidRequestStatus || "").toUpperCase();
    if (!record?.databaseBacked) return "未读取到数据库工单";
    if (voidStarted) {
      if (originalStatus === "VOIDED" || voidStatus === "APPROVED") return "该工单已作废";
      if (voidStatus === "REJECTED") return "作废申请已驳回，不能再次提交";
      return "该工单已提交过作废申请";
    }
    if (!isVoidableOriginalType(record)) return "仅已通过的正常充值可以申请作废";
    if (originalStatus === "PENDING") return "原工单审核通过后才可申请作废";
    if (originalStatus === "REJECTED") return "原工单未通过，不能申请作废";
    if (originalStatus === "VOIDED") return "该工单已作废";
    return "当前工单不能申请作废";
  }

  function setupVoidApplication(record, originalKind, voidStarted, canApply, storeMode) {
    if (type !== "recharge") return;
    const panel = $("storeVoidAction");
    const button = $("submitVoidApplication");
    const reasonField = $("voidReason");
    const reviewPanel = document.querySelector("[data-order-review]");
    panel.hidden = !storeMode;
    panel.classList.toggle("is-expanded", storeMode);
    reviewPanel?.classList.toggle("store-void-expanded", storeMode);
    reasonField.disabled = !canApply;
    button.onclick = null;
    button.disabled = !canApply;
    button.textContent = "提交作废申请";
    $("voidApplicationMessage").textContent = "";
    const actionHint = canApply ? "填写作废说明后提交" : voidActionUnavailableReason(record, voidStarted);
    button.title = actionHint;
    button.setAttribute("aria-label", `提交作废申请：${actionHint}`);
    if (!storeMode || !canApply) return;

    button.onclick = async () => {
      const reason = $("voidReason").value.trim();
      if (!reason) { $("voidApplicationMessage").textContent = "必须填写作废说明。"; return; }
      if (!window.confirm("确认提交作废申请？提交后将进入审核，审核通过前不会改变客户次数。")) return;
      if (typeof window.CloudBasePhoneAuth?.requestOrderVoid !== "function") {
        $("voidApplicationMessage").textContent = "作废申请服务未加载，请刷新页面重试。";
        return;
      }
      button.disabled = true;
      reasonField.disabled = true;
      button.textContent = "正在提交…";
      $("voidApplicationMessage").textContent = "正在写入作废审核申请…";
      let submitted = false;
      try {
        const result = await window.CloudBasePhoneAuth.requestOrderVoid({
          recordType: type.toUpperCase(),
          recordId: record.id,
          note: reason
        });
        const updated = {
          ...record,
          originalKind,
          originalStatus: record.status,
          voidStatus: "PENDING",
          voidSubmittedAt: result?.order?.void_requested_at || result?.void_requested_at || new Date().toISOString(),
          voidStoreNote: reason,
          voidReviewNote: ""
        };
        saveRecord(updated);
        submitted = true;
        renderRecord(updated);
      } catch (error) {
        $("voidApplicationMessage").textContent = error?.message || "作废申请提交失败。";
      } finally {
        if (!submitted) {
          button.disabled = false;
          reasonField.disabled = false;
          button.textContent = "提交作废申请";
        }
      }
    };
  }

  async function initialize() {
    configureBackLink();
    const recordId = first(params.get("recordId"));
    const displayCode = first(params.get("recordCode"), recordId);
    const recordReference = first(recordId, displayCode);
    const source = clean(params.get("source")).toLowerCase();
    const cached = findRecord(recordReference);
    const recordCode = first(params.get("recordCode"), /^\d+$/.test(recordId) ? "" : recordId).toUpperCase();
    const numericRecordId = /^\d+$/.test(recordId) ? recordId : "";
    const databaseReference = /^\d+$/.test(recordId) || /^[A-Z]{2}[A-Z0-9_-]{4,38}$/i.test(displayCode);
    const shouldReadDatabase = ["review", "created", "query"].includes(source) || databaseReference || cached?.databaseBacked === true;
    if (shouldReadDatabase) {
      renderMissing(displayCode);
      $("orderDescription").textContent = "正在从数据库读取该张工单…";
      $("orderStatus").className = "pending";
      $("orderStatus").textContent = "读取中";
      try {
        const session = readSession();
        if (session?.role === "teacher") {
          const record = await loadTeacherOrder(numericRecordId);
          saveRecord(record);
          renderRecord(record);
          return;
        }
        if (typeof window.CloudBasePhoneAuth?.listReviewOrders !== "function") throw new Error("工单数据服务未加载，请刷新页面重试");
        const orders = await window.CloudBasePhoneAuth.listReviewOrders({
          recordType: type.toUpperCase(),
          recordId: numericRecordId,
          recordCode,
          detailRead: true,
          // 数据库按 ID／完整业务编号精确读取，详情页永远只取一条。
          limit: 1
        });
        const exactOrder = Array.isArray(orders)
          ? orders.find((item) => (
              (recordCode && clean(field(item, "record_code", "recordCode")).toUpperCase() === recordCode) ||
              (numericRecordId && clean(item?.id) === numericRecordId)
            ))
          : null;
        const record = normalizeDatabaseOrder(exactOrder);
        if (!record) throw new Error("数据库中未找到该张工单");
        saveRecord(record);
        renderRecord(record);
      } catch (error) {
        renderMissing(displayCode);
        $("orderDescription").textContent = error?.message || (readSession()?.role === "teacher"
          ? "工单读取失败，请返回我的工作台后重试。"
          : "工单读取失败，请返回审核列表后重试。");
      }
      return;
    }
    if (cached) { renderRecord(cached); return; }
    const record = source === "created" ? null : recordFromQuery(recordReference);
    if (record) renderRecord(record);
    else renderMissing(displayCode);
  }

  $("closeVerificationPhotoViewer")?.addEventListener("click", () => $("verificationPhotoViewer")?.close());
  $("zoomOutVerificationPhoto")?.addEventListener("click", () => zoomVerificationPhotoViewer(verificationPhotoViewerScale / 1.25));
  $("zoomInVerificationPhoto")?.addEventListener("click", () => zoomVerificationPhotoViewer(verificationPhotoViewerScale * 1.25));
  $("resetVerificationPhotoZoom")?.addEventListener("click", resetVerificationPhotoViewerTransform);
  $("verificationPhotoOriginalFrame")?.addEventListener("pointerdown", handleVerificationPhotoViewerPointerDown);
  $("verificationPhotoOriginalFrame")?.addEventListener("pointermove", handleVerificationPhotoViewerPointerMove);
  $("verificationPhotoOriginalFrame")?.addEventListener("pointerup", handleVerificationPhotoViewerPointerEnd);
  $("verificationPhotoOriginalFrame")?.addEventListener("pointercancel", handleVerificationPhotoViewerPointerEnd);
  $("verificationPhotoOriginalFrame")?.addEventListener("lostpointercapture", handleVerificationPhotoViewerPointerEnd);
  $("verificationPhotoOriginalFrame")?.addEventListener("wheel", handleVerificationPhotoViewerWheel, { passive: false });
  $("verificationPhotoOriginalFrame")?.addEventListener("dblclick", (event) => {
    zoomVerificationPhotoViewer(verificationPhotoViewerScale > 1 ? 1 : 2.5, event.clientX, event.clientY);
  });
  $("verificationPhotoOriginalFrame")?.addEventListener("keydown", handleVerificationPhotoViewerKeydown);
  $("verificationPhotoViewer")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $("verificationPhotoViewer")?.addEventListener("close", () => {
    verificationPhotoViewerRequest += 1;
    resetVerificationPhotoViewerTransform();
    const image = $("verificationPhotoOriginal");
    image?.removeAttribute("src");
    if (image) { image.onload = null; image.onerror = null; delete image.dataset.photoQuality; }
    revokeVerificationPhotoViewerFallback();
  });
  $("captureVerificationPhotoCamera")?.addEventListener("click", captureVerificationPhotoCamera);
  $("switchVerificationPhotoCamera")?.addEventListener("click", switchVerificationPhotoCamera);
  $("verificationPhotoFileInput")?.addEventListener("change", handleVerificationPhotoFileSelected);
  $("cancelVerificationPhotoUpload")?.addEventListener("click", cancelVerificationPhotoUpload);
  $("retryVerificationPhotoUpload")?.addEventListener("click", retryVerificationPhotoUpload);
  $("cancelVerificationPhotoCamera")?.addEventListener("click", () => $("verificationPhotoCameraDialog")?.close());
  $("closeVerificationPhotoCamera")?.addEventListener("click", () => $("verificationPhotoCameraDialog")?.close());
  $("verificationPhotoCameraDialog")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $("verificationPhotoCameraDialog")?.addEventListener("close", () => stopVerificationPhotoCamera());
  window.addEventListener("resize", applyVerificationPhotoViewerTransform);
  window.addEventListener("pagehide", () => {
    stopVerificationPhotoCamera();
    verificationPhotoUploadTask?.worker?.terminate?.();
    verificationPhotoUploadTask?.xhrs?.forEach((xhr) => { try { xhr.abort(); } catch (_) { /* 页面正在退出 */ } });
    verificationPhotoPreloads.clear();
    verificationPhotoOriginalAuditCache.clear();
    verificationPhotoReadFlights.clear();
    verificationPhotoBlobFlights.clear();
    clearVerificationPhotoThumbnailFallbacks();
    revokeVerificationPhotoViewerFallback();
    clearVerificationPhotoLocalPreviews();
    clearProductReceiptLogoObjectUrl();
  });
  $("exportOrderPdf")?.addEventListener("click", () => exportCurrentOrder("pdf"));
  $("exportOrderImage")?.addEventListener("click", () => exportCurrentOrder("image"));

  setExportControls(false, "工单读取完成后可以导出。");
  initialize();

  document.documentElement.dataset.prototypeVersion = VERSION;
})();

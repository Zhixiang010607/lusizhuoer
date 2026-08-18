(() => {
  "use strict";

  const VERSION = "0.15.20";
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
  let verificationCameraStream = null;
  let verificationCameraTarget = null;
  let verificationCameraRequest = 0;
  let orderExportBusy = false;

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
    if (source === "review" && ["hq", "operation"].includes(session?.role)) {
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
      ? ({ NEW: "新充值" }[originalType] || originalType || "充值")
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
      ? ({ NEW: "新充值", VOID: "历史冲销" }[originalType] || originalType || "充值")
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
      customerCode: clean(row.customerCode),
      customerName: clean(row.customerName),
      projectCode: clean(row.productCode),
      projectName: clean(row.productName),
      teacherCode: clean(row.teacherCode),
      teacherName: clean(row.teacherName),
      count: row.unitCount,
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

  async function callFaceRecognition(data) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
      throw new Error("核销照片服务未加载，请刷新页面重试");
    }
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    photoServiceApp ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    let raw;
    try {
      raw = await photoServiceApp.callFunction({ name: "faceRecognition", data });
    } catch (error) {
      const diagnostic = [error?.code, error?.requestId || error?.RequestId].filter(Boolean).join(" · ");
      throw new Error(`${error?.message || "核销照片云函数调用失败"}${diagnostic ? `（${diagnostic}）` : ""}`);
    }
    const payload = cloudFunctionPayload(raw);
    if (!payload?.ok) {
      const error = new Error(payload?.message || "核销照片服务没有返回业务结果");
      error.code = payload?.code || "PHOTO_SERVICE_FAILED";
      throw error;
    }
    return payload;
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

  function exportDocumentData(record) {
    const recharge = type === "recharge";
    const facts = Array.from($("orderKeyfacts")?.children || []).map((element) => ({
      label: elementText(element, "span"),
      value: elementText(element, "strong")
    }));
    const details = Array.from($("orderInfo")?.children || []).map((element) => ({
      label: elementText(element, "span"),
      value: elementText(element, "strong")
    }));
    const messages = recharge
      ? Array.from($("orderComments")?.querySelectorAll(".order-comment-card") || []).map((element) => ({
          label: elementText(element, "h3"),
          value: elementText(element, "p") || "无",
          time: elementText(element, "time")
        }))
      : [
          { label: "门店留言", value: clean($("verificationStoreMessage")?.textContent) || "无", time: clean($("verificationStoreMessageTime")?.textContent) },
          { label: "总部留言", value: clean($("verificationHqMessage")?.textContent) || "无", time: clean($("verificationHqMessageTime")?.textContent) }
        ];
    const customerName = first(record.customerName, record.customerCode, "客户");
    const projectName = first(record.projectName, record.productName, record.projectCode, record.productCode, "项目");
    return {
      filename: `${customerName}+${projectName}+${recharge ? "充值" : "核销"}`,
      title: clean($("orderTitle")?.textContent) || `${recharge ? "充值" : "核销"}工单`,
      subtitle: clean($("orderDescription")?.textContent) || "业务工单完整导出",
      status: clean($("orderStatus")?.textContent) || "—",
      statusTone: $("orderStatus")?.classList.contains("rejected") ? "rejected" : $("orderStatus")?.classList.contains("pending") ? "pending" : "approved",
      facts,
      detailTitle: recharge ? "充值信息" : "核销信息",
      detailSubtitle: "该工单数据库中保存的完整业务内容",
      details,
      messages
    };
  }

  async function fetchVerificationPhotoBlob(recordId, photo) {
    const slot = Number(photo.slot);
    const payload = await callFaceRecognition({ action: "getVerificationPhotoOriginalUrl", recordId, slot });
    const response = await fetch(payload.photoUrl, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    });
    if (!response.ok) throw new Error(`${photoSlotLabel(slot)}读取失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (!blob.size || !String(blob.type || "").toLowerCase().startsWith("image/")) {
      throw new Error(`${photoSlotLabel(slot)}没有返回有效图片`);
    }
    return blob;
  }

  function exportPhotoFailureMeta(error) {
    const code = clean(error?.code).toUpperCase();
    const message = clean(error?.message);
    if (code === "PHOTO_NOT_FOUND" || message.includes("尚未上传") || message.includes("不存在")) return "照片文件未找到";
    if (code === "PHOTO_SIGN_FAILED" || message.includes("临时访问地址")) return "已保存 · 临时访问地址生成失败";
    if (message.includes("HTTP") || message.includes("下载")) return "已保存 · 照片下载失败";
    return "已保存 · 导出时暂无法读取原图";
  }

  async function verificationExportPhotos(record) {
    await verificationPhotoLoadPromise;
    const listError = currentVerificationPhotoPayload?.error || null;
    const available = new Map((currentVerificationPhotoPayload?.photos || []).map((photo) => [Number(photo.slot), photo]));
    const output = Array.from({ length: 5 }, (_, slot) => ({
      slot,
      label: photoSlotLabel(slot),
      meta: listError ? "照片清单读取失败" : available.has(slot) ? "正在读取高清原图" : "空照片位",
      placeholder: listError ? "照片信息暂不可用" : available.has(slot) ? "照片读取中" : "尚未上传",
      blob: null
    }));
    if (listError) return { photos: output, warning: "照片清单暂无法读取，已保留五个照片位和说明" };
    const queue = Array.from(available.values()).filter((photo) => Number.isInteger(Number(photo.slot)) && Number(photo.slot) >= 0 && Number(photo.slot) <= 4);
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (cursor < queue.length) {
        const index = cursor;
        cursor += 1;
        const photo = queue[index];
        const slot = Number(photo.slot);
        try {
          const blob = await fetchVerificationPhotoBlob(clean(record.id), photo);
          output[slot] = {
            slot,
            label: photoSlotLabel(slot),
            meta: [photoSizeLabel(blob.size), formatTime(photo.uploadedAt) || "已保存"].filter(Boolean).join(" · "),
            placeholder: "照片读取失败",
            blob
          };
        } catch (error) {
          failed += 1;
          output[slot] = {
            slot,
            label: photoSlotLabel(slot),
            meta: exportPhotoFailureMeta(error),
            placeholder: "照片暂无法读取",
            blob: null
          };
        } finally {
          completed += 1;
          setExportControls(false, `正在读取核销高清照片 ${completed} / ${queue.length}…`);
        }
      }
    });
    await Promise.all(workers);
    return {
      photos: output,
      warning: failed ? `${failed} 张照片暂无法读取，已用占位信息完成导出` : ""
    };
  }

  async function exportCurrentOrder(format) {
    if (orderExportBusy || !currentRecord) return;
    if (!window.OrderExporter?.exportOrder) {
      setExportControls(true, "导出组件未加载，请刷新页面重试。");
      return;
    }
    orderExportBusy = true;
    setExportControls(false, type === "verification" ? "正在准备工单与照片…" : "正在生成完整工单…");
    try {
      const photoResult = type === "verification" ? await verificationExportPhotos(currentRecord) : { photos: [], warning: "" };
      setExportControls(false, format === "pdf" ? "正在分页生成 PDF…" : "正在生成高清图片…");
      const result = await window.OrderExporter.exportOrder({
        format,
        documentData: exportDocumentData(currentRecord),
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
    if (["APPROVED", "ACTIVE", "COMPLETED"].includes(code)) return { label: "已通过", className: "approved", hint: "审核已完成" };
    if (code === "VOIDED") return { label: "已作废", className: "rejected", hint: "历史工单状态为已作废" };
    if (["REJECTED", "ARCHIVED", "CANCELLED"].includes(code)) return { label: "已驳回", className: "rejected", hint: "该工单已被驳回" };
    return { label: "待审核", className: "pending", hint: "等待总部或运营处理" };
  }

  function labelParts(name, code, emptyLabel = "—") {
    const safeName = clean(name);
    const safeCode = clean(code);
    if (!safeName && !safeCode) return { name: emptyLabel, code: "" };
    return { name: safeName || safeCode, code: safeName && safeCode && safeName !== safeCode ? safeCode : "" };
  }

  function inlineLabel(name, code, emptyLabel = "—") {
    const parts = labelParts(name, code, emptyLabel);
    return parts.code ? `${parts.name} · ${parts.code}` : parts.name;
  }

  function factCard(label, name, code, emptyLabel = "—") {
    const parts = labelParts(name, code, emptyLabel);
    return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(parts.name)}${parts.code ? ` <em>· ${escapeHtml(parts.code)}</em>` : ""}</strong></div>`;
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
    const hqMessage = first(record?.initialHqNote, record?.reviewNote, record?.hqReviewNote, record?.approvalNote, record?.rejectionNote);
    $("reviewPanelTitle").textContent = "工单留言";
    $("reviewPanelHint").textContent = "门店提交留言与总部审核留言集中显示；长留言可在各自区域内上下滚动。";
    $("verificationStoreMessage").textContent = storeMessage || "无";
    $("verificationHqMessage").textContent = hqMessage || "无";
    $("verificationStoreMessageTime").textContent = formatTime(first(record?.createdAt, record?.submittedAt)) || "—";
    $("verificationHqMessageTime").textContent = formatTime(first(record?.reviewedAt, record?.approvedAt, record?.rejectedAt)) || "—";
  }

  function photoSlotLabel(slot) {
    if (slot === 0) return "客户原始留存照";
    if (slot === 1) return "本次核销人脸照";
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

  function resetVerificationPhotoPanel(message = "正在读取私有照片权限与缩略图…") {
    const panel = $("verificationPhotoPanel");
    if (!panel) return;
    currentVerificationPhotoPayload = null;
    verificationPhotoRequest += 1;
    $("verificationPhotoCount").textContent = "0 / 5";
    $("verificationPhotoHint").textContent = message;
    $("verificationPhotoGrid").innerHTML = Array.from({ length: 5 }, (_, slot) => `
      <article class="verification-photo-card">
        <div class="verification-photo-preview"><span>${slot < 2 ? "正在读取只读照片…" : "正在读取…"}</span></div>
        <div class="verification-photo-card-body"><div><strong>${escapeHtml(photoSlotLabel(slot))}</strong><span>—</span></div></div>
      </article>`).join("");
    $("verificationPhotoMessage").className = "verification-photo-message";
    $("verificationPhotoMessage").textContent = "";
  }

  function verificationPhotoCard(photo, slot, payload) {
    const label = photoSlotLabel(slot);
    const canUpload = slot >= 2 && payload.canEdit === true;
    const preview = photo
      ? `<button class="verification-photo-preview has-photo" type="button" data-view-verification-photo="${slot}" aria-label="查看${escapeHtml(label)}原图">${photo.thumbnailUrl ? `<img src="${escapeHtml(photo.thumbnailUrl)}" alt="${escapeHtml(label)}缩略图" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : "<span>缩略图暂不可用<br>点击读取原图</span>"}</button>`
      : `<div class="verification-photo-preview"><span>${slot === 0 ? "未保存客户留存照" : slot === 1 ? "未保存本次人脸凭证" : "尚未上传"}</span></div>`;
    const size = photoSizeLabel(photo?.originalBytes);
    const meta = photo ? [size, formatTime(photo.uploadedAt) || "已绑定"].filter(Boolean).join(" · ") : "空照片位";
    const libraryLabel = usesMobilePhotoLibrary() ? (photo ? "从相册替换" : "从相册上传") : (photo ? "上传替换" : "上传文件");
    const actions = slot < 2 ? "" : `<div class="verification-photo-actions">
      <button class="verification-photo-upload verification-photo-camera" type="button" data-capture-verification-photo="${slot}" ${canUpload ? "" : "disabled"}>${photo ? "重新拍照" : "拍照"}</button>
      <button class="verification-photo-upload" type="button" data-upload-verification-photo="${slot}" ${canUpload ? "" : "disabled"}>${libraryLabel}</button>
    </div>`;
    return `<article class="verification-photo-card">${preview}<div class="verification-photo-card-body"><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(meta)}</span></div>${actions}</div></article>`;
  }

  function renderVerificationPhotos(payload, recordId) {
    const photos = Array.isArray(payload?.photos) ? payload.photos : [];
    currentVerificationPhotoPayload = { ...payload, photos, error: null };
    const bySlot = new Map(photos.map((photo) => [Number(photo.slot), photo]));
    $("verificationPhotoCount").textContent = `${photos.length} / 5`;
    const deadline = formatTime(payload?.editableUntil);
    $("verificationPhotoHint").textContent = payload?.canEdit
      ? `你是本单提交人，可在 ${deadline || "提交后 24 小时内"} 前上传或替换 3 张补充照片。客户留存照与本次核销人脸照均不可修改。`
      : payload?.isSubmitter
      ? `照片修改窗口已于 ${deadline || "提交后 24 小时"} 结束；现有照片永久只读。`
      : "照片仅供有权查看本核销单的账号浏览；只有本单提交人可在 24 小时内上传或替换补充照片。";
    $("verificationPhotoGrid").innerHTML = Array.from({ length: 5 }, (_, slot) => verificationPhotoCard(bySlot.get(slot), slot, payload)).join("");
    $("verificationPhotoGrid").querySelectorAll("[data-view-verification-photo]").forEach((button) => {
      button.addEventListener("click", () => openVerificationPhoto(recordId, Number(button.dataset.viewVerificationPhoto)));
    });
    $("verificationPhotoGrid").querySelectorAll("[data-capture-verification-photo]").forEach((button) => {
      button.addEventListener("click", () => openVerificationPhotoCamera(recordId, Number(button.dataset.captureVerificationPhoto)));
    });
    $("verificationPhotoGrid").querySelectorAll("[data-upload-verification-photo]").forEach((button) => {
      button.addEventListener("click", () => chooseVerificationPhoto(recordId, Number(button.dataset.uploadVerificationPhoto)));
    });
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
      const payload = await callFaceRecognition({ action: "getVerificationPhotos", recordId });
      if (request !== verificationPhotoRequest) return;
      renderVerificationPhotos(payload, recordId);
      return payload;
    } catch (error) {
      if (request !== verificationPhotoRequest) return;
      currentVerificationPhotoPayload = { photos: [], error };
      $("verificationPhotoHint").textContent = "核销照片读取失败";
      $("verificationPhotoMessage").className = "verification-photo-message error";
      $("verificationPhotoMessage").textContent = error?.message || "请核对迁移 037、038、私有存储桶和云函数版本";
      $("verificationPhotoGrid").innerHTML = "";
      return null;
    }
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("浏览器无法生成 JPEG 照片")), "image/jpeg", quality));
  }

  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
      reader.addEventListener("error", () => reject(new Error("浏览器无法读取所选照片")), { once: true });
      reader.readAsDataURL(blob);
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

  async function prepareVerificationPhoto(file) {
    const image = await decodePhotoFile(file);
    const naturalWidth = Number(image.width || image.naturalWidth || 0);
    const naturalHeight = Number(image.height || image.naturalHeight || 0);
    if (!naturalWidth || !naturalHeight) throw new Error("无法读取照片尺寸");
    const originalScale = Math.min(1, 2400 / Math.max(naturalWidth, naturalHeight));
    const original = document.createElement("canvas");
    original.width = Math.max(1, Math.round(naturalWidth * originalScale));
    original.height = Math.max(1, Math.round(naturalHeight * originalScale));
    original.getContext("2d", { alpha: false }).drawImage(image, 0, 0, original.width, original.height);
    image.close?.();
    let originalBlob = await canvasBlob(original, 0.92);
    if (originalBlob.size > 3 * 1024 * 1024) originalBlob = await canvasBlob(original, 0.86);
    if (originalBlob.size > 3 * 1024 * 1024) {
      const reducedScale = Math.min(1, 1800 / Math.max(original.width, original.height));
      const reduced = document.createElement("canvas");
      reduced.width = Math.max(1, Math.round(original.width * reducedScale));
      reduced.height = Math.max(1, Math.round(original.height * reducedScale));
      reduced.getContext("2d", { alpha: false }).drawImage(original, 0, 0, reduced.width, reduced.height);
      original.width = reduced.width; original.height = reduced.height;
      original.getContext("2d", { alpha: false }).drawImage(reduced, 0, 0);
      originalBlob = await canvasBlob(original, 0.88);
    }
    if (originalBlob.size > 3 * 1024 * 1024) throw new Error("照片处理后仍超过 3 MB，请换一张照片");
    const thumbScale = Math.min(1, 480 / Math.max(original.width, original.height));
    const thumbnail = document.createElement("canvas");
    thumbnail.width = Math.max(1, Math.round(original.width * thumbScale));
    thumbnail.height = Math.max(1, Math.round(original.height * thumbScale));
    thumbnail.getContext("2d", { alpha: false }).drawImage(original, 0, 0, thumbnail.width, thumbnail.height);
    const thumbnailBlob = await canvasBlob(thumbnail, 0.82);
    return {
      imageBase64: await blobDataUrl(originalBlob),
      thumbnailBase64: await blobDataUrl(thumbnailBlob),
      imageWidth: original.width,
      imageHeight: original.height
    };
  }

  function setVerificationPhotoButtonsDisabled(disabled) {
    $("verificationPhotoGrid")?.querySelectorAll("button").forEach((button) => { button.disabled = disabled; });
  }

  async function uploadVerificationPhoto(recordId, slot, file) {
    if (verificationPhotoUploadBusy) return;
    verificationPhotoUploadBusy = true;
    const status = $("verificationPhotoMessage");
    status.className = "verification-photo-message";
    status.textContent = `正在处理并上传${photoSlotLabel(slot)}…`;
    setVerificationPhotoButtonsDisabled(true);
    try {
      const images = await prepareVerificationPhoto(file);
      await callFaceRecognition({ action: "uploadVerificationExtraPhoto", recordId, slot, ...images });
      status.textContent = `${photoSlotLabel(slot)}已安全保存。`;
      await loadVerificationPhotos({ id: recordId, databaseBacked: true });
    } catch (error) {
      await loadVerificationPhotos({ id: recordId, databaseBacked: true });
      $("verificationPhotoMessage").className = "verification-photo-message error";
      $("verificationPhotoMessage").textContent = error?.message || "照片上传失败，请重试";
    } finally {
      verificationPhotoUploadBusy = false;
    }
  }

  function chooseVerificationPhoto(recordId, slot) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("aria-label", `从相册或文件中选择${photoSlotLabel(slot)}`);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      uploadVerificationPhoto(recordId, slot, file);
    }, { once: true });
    input.click();
  }

  function stopVerificationPhotoCamera(clearTarget = true) {
    verificationCameraRequest += 1;
    verificationCameraStream?.getTracks?.().forEach((track) => track.stop());
    verificationCameraStream = null;
    const video = $("verificationPhotoCameraVideo");
    if (video) video.srcObject = null;
    const capture = $("captureVerificationPhotoCamera");
    if (capture) capture.disabled = true;
    const placeholder = $("verificationPhotoCameraPlaceholder");
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.textContent = "正在开启摄像头…";
    }
    if (clearTarget) verificationCameraTarget = null;
  }

  async function openVerificationPhotoCamera(recordId, slot) {
    const dialog = $("verificationPhotoCameraDialog");
    const video = $("verificationPhotoCameraVideo");
    const message = $("verificationPhotoCameraMessage");
    const placeholder = $("verificationPhotoCameraPlaceholder");
    if (!dialog || !video || !message || !placeholder) return;
    stopVerificationPhotoCamera();
    verificationCameraTarget = { recordId, slot };
    const request = verificationCameraRequest;
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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      if (request !== verificationCameraRequest || !dialog.open) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      verificationCameraStream = stream;
      video.srcObject = stream;
      await video.play();
      if (request !== verificationCameraRequest || !dialog.open) return;
      placeholder.hidden = true;
      $("captureVerificationPhotoCamera").disabled = false;
      message.textContent = "摄像头已开启。调整画面后点击“拍摄并使用”。";
    } catch (error) {
      verificationCameraStream?.getTracks?.().forEach((track) => track.stop());
      verificationCameraStream = null;
      video.srcObject = null;
      placeholder.hidden = false;
      placeholder.textContent = "摄像头开启失败";
      message.className = "verification-photo-camera-message error";
      message.textContent = error?.name === "NotAllowedError"
        ? "未获得摄像头权限。请在浏览器设置中允许摄像头，或使用“上传文件”从相册选择。"
        : "无法使用摄像头。请检查设备摄像头，或使用“上传文件”从相册选择。";
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
    if (!target || !canvas || !width || !height || verificationPhotoUploadBusy) {
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
      const photo = await canvasBlob(canvas, 0.96);
      $("verificationPhotoCameraDialog").close();
      await uploadVerificationPhoto(target.recordId, target.slot, photo);
    } catch (error) {
      capture.disabled = false;
      message.className = "verification-photo-camera-message error";
      message.textContent = error?.message || "拍摄失败，请重试";
    }
  }

  async function openVerificationPhoto(recordId, slot) {
    const dialog = $("verificationPhotoViewer");
    const image = $("verificationPhotoOriginal");
    if (!dialog || !image) return;
    $("verificationPhotoViewerTitle").textContent = `${photoSlotLabel(slot)} · 正在加载原图`;
    image.removeAttribute("src");
    image.alt = `${photoSlotLabel(slot)}原图`;
    dialog.showModal();
    try {
      const payload = await callFaceRecognition({ action: "getVerificationPhotoOriginalUrl", recordId, slot });
      image.src = payload.photoUrl;
      $("verificationPhotoViewerTitle").textContent = `${photoSlotLabel(slot)} · ${payload.width || "—"} × ${payload.height || "—"}`;
    } catch (error) {
      $("verificationPhotoViewerTitle").textContent = error?.message || "原图读取失败";
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
    verificationPhotoLoadPromise = Promise.resolve();
    setExportControls(false, "工单读取完成后可以导出。");
    const session = readSession();
    const recharge = type === "recharge";
    const storeMode = session?.role === "store";
    const teacherMode = session?.role === "teacher";
    $("orderKindTag").textContent = recharge ? "充值" : "核销";
    $("orderTitle").textContent = `${recharge ? "充值单" : "核销单"} ${recordId || "—"}`;
    $("orderDescription").textContent = "未找到该工单的数据，请返回查询页面后重新进入。";
    $("orderStatus").className = "rejected";
    $("orderStatus").textContent = "读取失败";
    $("orderStatusHint").textContent = "当前页面没有收到工单数据";
    $("orderKeyfacts").innerHTML = ["门店", "客户", "项目", "业务老师"].map((label) => factCard(label, "", "")).join("");
    $("orderInfo").innerHTML = infoCard(recharge ? "充值单编号" : "核销单编号", recordId);
    if (!recharge) {
      renderVerificationMessages(null);
      resetVerificationPhotoPanel("尚未读取到可关联的数据库核销单。");
      return;
    }
    $("reviewStatusRow").hidden = storeMode;
    document.querySelector("[data-order-review]")?.classList.toggle("store-void-mode", storeMode);
    $("reviewStatus").textContent = "—";
    $("reviewMessage").value = "";
    $("orderComments").innerHTML = "";
    if (storeMode) {
      $("reviewPanelTitle").textContent = "作废申请";
      $("reviewPanelHint").textContent = "原工单审核通过后可提交一次作废申请。";
      $("reviewNoteField").hidden = true;
      $("reviewActions").hidden = true;
    } else if (teacherMode) {
      $("reviewPanelTitle").textContent = "审核结果";
      $("reviewPanelHint").textContent = "老师仅可查看本人绑定工单的审核结果与已有留言。";
      $("reviewNoteField").hidden = true;
      $("reviewActions").hidden = true;
    }
    setupVoidApplication(null, "", false, false, storeMode);
  }

  function renderRecord(record) {
    currentRecord = record;
    const recharge = type === "recharge";
    const recordCode = first(record.recordCode, record.rechargeCode, record.verificationCode, record.id);
    const voidStarted = recharge && hasVoidLifecycle(record);
    const normalKind = recharge
      ? first(record.originalKind, record.applicationType, record.rechargeType, "新充值")
      : first(record.originalKind, record.verificationType, record.applicationType, "正常核销");
    const voidActive = recharge && voidStarted && String(record.voidStatus || "").toUpperCase() !== "REJECTED";
    const kind = voidActive ? "作废申请" : normalKind;
    const originalStatusCode = String(record.status || record.recordStatus || "").toUpperCase();
    const status = statusView(originalStatusCode === "VOIDED"
      ? "VOIDED"
      : recharge && voidStarted
      ? first(record.voidStatus, record.voidRequestStatus)
      : originalStatusCode);
    if (recharge && originalStatusCode === "VOIDED") {
      status.hint = record.balanceRestored === false
        ? "作废审核已通过；原单尚未生效，客户次数无需恢复"
        : "作废审核已通过，客户次数已恢复";
    }
    const storeCode = first(record.storeCode, record.storeId);
    const customerCode = first(record.customerCode, record.customerId);
    const projectCode = first(record.projectCode, record.productCode, record.projectId, record.productId);
    const teacherCode = first(record.teacherCode, record.teacherId);
    const customerLabel = inlineLabel(record.customerName, customerCode);
    const projectLabel = inlineLabel(first(record.projectName, record.productName), projectCode);
    const teacherLabel = inlineLabel(record.teacherName, teacherCode, "未指定");
    const submittedAt = formatTime(first(record.createdAt, record.submittedAt));
    const reviewedAt = formatTime(first(record.reviewedAt, record.approvedAt, record.rejectedAt));
    const reviewMessage = first(record.reviewNote, record.hqReviewNote, record.approvalNote, record.rejectionNote);
    const countNumber = Number(first(record.count, record.unitCount, recharge ? "0" : "1"));
    const countLabel = recharge
      ? (Number.isFinite(countNumber) && countNumber > 0 ? `${String(record.originalType || "").toUpperCase() === "VOID" ? "−" : "+"}${countNumber}` : "—")
      : (Number.isFinite(countNumber) && countNumber > 0 ? String(countNumber) : "1");
    const session = readSession();
    const isReviewer = ["hq", "operation"].includes(session?.role);
    const storeMode = session?.role === "store";
    const canStoreVoid = canStoreRequestVoid(record, storeMode, voidStarted);
    const description = recharge && String(record.voidStatus || "").toUpperCase() === "REJECTED"
      ? "作废申请已被驳回，原业务与客户次数保持不变。"
      : recharge && voidStarted
      ? `${first(record.storeName, "该门店")}已提交作废申请；审核通过前不改变客户次数。`
      : session?.role === "store"
      ? `${first(record.storeName, "该门店")}自己的${recharge ? "充值" : "核销"}工单。`
      : "该工单展示本次实际提交的业务内容。";

    $("orderKindTag").textContent = kind;
    $("orderTitle").textContent = `${recharge ? "充值单" : "核销单"} ${recordCode || "—"}`;
    $("orderDescription").textContent = description;
    $("orderStatus").className = status.className;
    $("orderStatus").textContent = status.label;
    $("orderStatusHint").textContent = status.hint;

    $("orderKeyfacts").innerHTML = [
      factCard("门店", record.storeName, storeCode),
      factCard("客户", record.customerName, customerCode),
      factCard("项目", first(record.projectName, record.productName), projectCode),
      factCard("业务老师", record.teacherName, teacherCode, "未指定")
    ].join("");

    const items = recharge
      ? [["充值单编号", recordCode], ["申请类型", kind], ["客户", customerLabel], ["项目", projectLabel], ["业务老师", teacherLabel], ["充值次数", countLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]]
      : [["核销单编号", recordCode], ["核销类型", kind], ["客户", customerLabel], ["项目", projectLabel], ["业务老师", teacherLabel], ["核销次数", countLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]];
    $("orderInfo").innerHTML = items.map(([label, value]) => infoCard(label, value)).join("");

    if (!recharge) {
      renderVerificationMessages(record);
      verificationPhotoLoadPromise = loadVerificationPhotos(record);
      setExportControls(true, "可导出完整工单；导出时会按权限读取高清照片。");
      return;
    }

    $("reviewStatus").textContent = status.label;
    $("reviewStatusRow").hidden = storeMode;
    document.querySelector("[data-order-review]")?.classList.toggle("store-void-mode", storeMode);
    $("reviewMessage").value = reviewMessage;
    $("reviewMessage").setAttribute("aria-label", reviewMessage ? "审核留言" : "暂无审核留言");
    $("reviewPanelTitle").textContent = isReviewer ? "总部审核" : storeMode ? "作废申请" : "审核结果";
    $("reviewNoteField").hidden = !isReviewer;
    $("reviewActions").hidden = !isReviewer;
    $("reviewPanelHint").textContent = isReviewer
      ? "请前往审核中心处理本工单；此详情页与总部工单模板保持一致。"
      : canStoreVoid
      ? "填写作废说明后提交；工单将重新以作废状态进入审核，审核通过前不改变客户次数。"
      : storeMode && voidStarted
      ? "作废申请已提交；留言已记录在下方。"
      : storeMode
      ? "仅已通过且尚未作废的正常充值工单可提交一次作废申请。"
      : session?.role === "teacher"
      ? "老师仅可查看本人绑定工单的审核状态和已有留言记录。"
      : "门店仅可查看审核状态和完整留言记录。";
    renderComments(record);
    setupVoidApplication(record, normalKind, voidStarted, canStoreVoid, storeMode);
    setExportControls(true, "可导出完整充值工单。");
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
  $("verificationPhotoViewer")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $("verificationPhotoViewer")?.addEventListener("close", () => $("verificationPhotoOriginal")?.removeAttribute("src"));
  $("captureVerificationPhotoCamera")?.addEventListener("click", captureVerificationPhotoCamera);
  $("cancelVerificationPhotoCamera")?.addEventListener("click", () => $("verificationPhotoCameraDialog")?.close());
  $("closeVerificationPhotoCamera")?.addEventListener("click", () => $("verificationPhotoCameraDialog")?.close());
  $("verificationPhotoCameraDialog")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $("verificationPhotoCameraDialog")?.addEventListener("close", () => stopVerificationPhotoCamera());
  window.addEventListener("pagehide", () => stopVerificationPhotoCamera());
  $("exportOrderPdf")?.addEventListener("click", () => exportCurrentOrder("pdf"));
  $("exportOrderImage")?.addEventListener("click", () => exportCurrentOrder("image"));

  setExportControls(false, "工单读取完成后可以导出。");
  initialize();

  document.documentElement.dataset.prototypeVersion = VERSION;
})();

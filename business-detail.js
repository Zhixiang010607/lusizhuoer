(() => {
  "use strict";

  const VERSION = "0.15.14";
  const type = document.body.dataset.recordDetail;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

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

  initialize();

  document.documentElement.dataset.prototypeVersion = VERSION;
})();

(() => {
  "use strict";

  const VERSION = "0.14.39";
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

  function formatTime(value) {
    const text = clean(value);
    if (!text) return "";
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return date.toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).replace(/\//g, "-");
  }

  function statusView(value) {
    const code = first(value, "PENDING").toUpperCase();
    if (["APPROVED", "ACTIVE", "COMPLETED"].includes(code)) return { label: "已通过", className: "approved", hint: "审核已完成" };
    if (code === "VOIDED") return { label: "已作废", className: "rejected", hint: "作废审核已通过，客户次数已恢复" };
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
    return loadSessionRows(key).find((row) => String(row?.id || row?.recordCode || "") === recordId) || null;
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
    $("orderKindTag").textContent = type === "recharge" ? "充值" : "核销";
    $("orderTitle").textContent = `${type === "recharge" ? "充值单" : "核销单"} ${recordId || "—"}`;
    $("orderDescription").textContent = "未找到该工单的数据，请返回查询页面后重新进入。";
    $("orderStatus").className = "rejected";
    $("orderStatus").textContent = "读取失败";
    $("orderStatusHint").textContent = "当前页面没有收到工单数据";
    $("reviewStatus").textContent = "—";
    $("reviewMessage").value = "";
    $("orderKeyfacts").innerHTML = ["门店", "客户", "项目", "业务老师"].map((label) => factCard(label, "", "")).join("");
    $("orderInfo").innerHTML = infoCard(type === "recharge" ? "充值单编号" : "核销单编号", recordId);
    $("orderComments").innerHTML = "";
    $("voidApplicationPanel").hidden = true;
  }

  function renderRecord(record) {
    const recharge = type === "recharge";
    const recordCode = first(record.recordCode, record.rechargeCode, record.verificationCode, record.id);
    const voidStarted = Boolean(record.voidSubmittedAt || record.voidStatus || record.voidStoreNote);
    const normalKind = recharge
      ? first(record.originalKind, record.applicationType, record.rechargeType, "新充值")
      : first(record.originalKind, record.verificationType, record.applicationType, "正常核销");
    const voidActive = voidStarted && String(record.voidStatus || "").toUpperCase() !== "REJECTED";
    const kind = voidActive ? (recharge ? "作废申请" : "作废核销") : normalKind;
    const status = statusView(first(record.status, record.recordStatus));
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
      ? (Number.isFinite(countNumber) && countNumber > 0 ? `+${countNumber}` : "—")
      : (Number.isFinite(countNumber) && countNumber > 0 ? String(countNumber) : "1");
    const session = readSession();
    const description = String(record.voidStatus || "").toUpperCase() === "REJECTED"
      ? "作废申请已被驳回，原业务与客户次数保持不变。"
      : voidStarted
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
    $("reviewStatus").textContent = status.label;
    $("reviewMessage").value = reviewMessage;
    $("reviewMessage").setAttribute("aria-label", reviewMessage ? "审核留言" : "暂无审核留言");
    const isReviewer = ["hq", "operation"].includes(session?.role);
    $("reviewPanelTitle").textContent = isReviewer ? "总部审核" : "审核结果";
    $("reviewNoteField").hidden = !isReviewer;
    $("reviewActions").hidden = !isReviewer;
    $("reviewPanelHint").textContent = isReviewer
      ? "请前往审核中心处理本工单；此详情页与总部工单模板保持一致。"
      : "门店仅可查看审核状态和完整留言记录。";

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
    renderComments(record);
    setupVoidApplication(record, normalKind, voidStarted, session);
  }

  function setupVoidApplication(record, originalKind, voidStarted, session) {
    const panel = $("voidApplicationPanel");
    const canApply = session?.role === "store" && !voidStarted && String(record.status || "").toUpperCase() === "APPROVED";
    panel.hidden = !canApply;
    if (!canApply) return;
    $("submitVoidApplication").onclick = () => {
      const reason = $("voidReason").value.trim();
      if (!reason) { $("voidApplicationMessage").textContent = "必须填写作废说明。"; return; }
      if (!window.confirm("确认提交作废申请？提交后将进入审核，审核通过前不会改变客户次数。")) return;
      const now = new Date().toISOString();
      const voidKind = type === "recharge" ? "作废充值" : "作废";
      const updated = {
        ...record,
        originalKind,
        originalStatus: record.status,
        voidStatus: "PENDING",
        voidSubmittedAt: now,
        voidStoreNote: reason,
        voidReviewNote: "",
        status: "PENDING",
        applicationType: type === "recharge" ? "作废申请" : record.applicationType,
        verificationType: type === "verification" ? "作废核销" : record.verificationType
      };
      saveRecord(updated);
      const applicationKey = type === "recharge" ? "prototypeRechargeApplications" : "prototypeVerificationReviewApplications";
      const applications = loadSessionRows(applicationKey);
      applications.unshift({
        id: `AP-${type === "recharge" ? "R" : "V"}-${Date.now()}`,
        kind: voidKind,
        recordId: updated.id,
        storeId: updated.storeId,
        customerId: updated.customerId,
        customerName: updated.customerName,
        projectId: updated.projectId,
        project: updated.projectName,
        projectName: updated.projectName,
        teacherId: updated.teacherId || "",
        count: updated.count,
        unitCount: updated.count,
        applicantNote: reason,
        initialStoreNote: first(record.initialStoreNote, record.note),
        initialHqNote: first(record.initialHqNote, record.reviewNote),
        status: "pending",
        time: now,
        createdAt: now,
        isVoidApplication: true
      });
      try { sessionStorage.setItem(applicationKey, JSON.stringify(applications)); } catch (_) { /* 静态原型 */ }
      location.reload();
    };
  }

  const recordId = first(params.get("recordId"));
  const record = findRecord(recordId) || (params.get("source") === "created" ? null : recordFromQuery(recordId));
  if (record) renderRecord(record);
  else renderMissing(recordId);

  document.documentElement.dataset.prototypeVersion = VERSION;
})();

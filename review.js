(() => {
  "use strict";
  const VERSION = "0.17.2";
  const pageType = document.body.dataset.review;
  const recordType = pageType === "recharge" ? "RECHARGE" : "VERIFICATION";
  const columnCount = 10;
  const $ = (id) => document.getElementById(id);
  const statusText = { PENDING: "待审核", APPROVED: "已通过", REJECTED: "已驳回" };
  let rows = [], pendingAction = null, loadingSequence = 0, session = null, queryMode = "filters";
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  let canDecide = false;
  let reviewerRole = "审核人员";
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const pick = (row, snake, camel) => row?.[snake] ?? row?.[camel] ?? "";
  const clean = (value) => String(value ?? "").trim();
  function staffCodeFor(role, staffId) {
    const id = clean(staffId);
    if (!id) return "";
    const prefix = role === "hq" ? "HQ" : role === "operation" ? "OP" : role === "teacher" ? "TCH" : "S";
    return `${prefix}${id.padStart(3, "0")}`;
  }
  function formatTime(value) {
    return window.AppDateTime.format(value);
  }
  function normalizeRow(row) {
    const applicationType = clean(pick(row, "application_type", "applicationType")).toUpperCase();
    const status = clean(pick(row, "application_status", "applicationStatus")).toUpperCase() || "PENDING";
    const isVoid = applicationType === "VOID";
    const customerCode = clean(pick(row, "customer_code", "customerCode"));
    return {
      raw: row, id: clean(row.id), recordCode: clean(pick(row, "record_code", "recordCode")), isVoid, status,
      kind: pageType === "recharge" ? (isVoid ? "作废充值" : "新充值") : (isVoid ? "作废" : "补录"),
      time: pick(row, "application_time", "applicationTime"),
      reviewedAt: isVoid ? pick(row, "void_reviewed_at", "voidReviewedAt") : pick(row, "original_reviewed_at", "originalReviewedAt"),
      originalCreatedAt: pick(row, "original_submitted_at", "originalSubmittedAt"), originalReviewedAt: pick(row, "original_reviewed_at", "originalReviewedAt"),
      initialStoreNote: pick(row, "initial_store_note", "initialStoreNote"), initialHqNote: pick(row, "initial_review_note", "initialReviewNote"),
      applicantNote: isVoid ? pick(row, "void_request_note", "voidRequestNote") : pick(row, "initial_store_note", "initialStoreNote"),
      operatorNote: isVoid ? pick(row, "void_review_note", "voidReviewNote") : pick(row, "initial_review_note", "initialReviewNote"),
      store: { id: clean(pick(row, "store_id", "storeId")), code: clean(pick(row, "store_code", "storeCode")), name: clean(pick(row, "store_name", "storeName")) || "未命名门店" },
      customerCode, customerId: customerCode || clean(pick(row, "customer_id", "customerId")), customerName: clean(pick(row, "customer_name", "customerName")) || "未命名客户",
      projectId: clean(pick(row, "product_code", "productCode")) || clean(pick(row, "product_id", "productId")), project: clean(pick(row, "product_name", "productName")) || "未命名项目",
      teacherId: clean(pick(row, "teacher_code", "teacherCode")), teacherName: clean(pick(row, "teacher_name", "teacherName")), amount: Number(pick(row, "unit_count", "unitCount")) || 0
    };
  }
  function applicationTypeFilter() {
    const value = $("reviewType").value;
    if (value === "all") return "";
    if (value === "作废充值" || value === "作废") return "VOID";
    return pageType === "recharge" ? "NEW" : "SUPPLEMENT";
  }
  function setLoading(message) {
    $("reviewBody").innerHTML = `<tr><td colspan="${columnCount}" class="query-empty">${escapeHtml(message)}</td></tr>`;
    $("reviewCount").innerHTML = `<strong>—</strong><span>${escapeHtml(message)}</span>`;
  }
  function saveAuthoritativeSession(data) {
    const profile = data?.profile || {};
    const role = clean(profile.role).toLowerCase();
    const expectedUid = clean(session?.cloudbaseUserId);
    const currentUid = clean(data?.uid);
    const expectedRole = clean(session?.role).toLowerCase();
    if (expectedUid && currentUid && expectedUid !== currentUid) {
      const error = new Error("此浏览器已经切换到另一个登录账号，旧审核页面不能继续使用");
      error.code = "AUTH_SESSION_CHANGED";
      throw error;
    }
    if (expectedRole && role && expectedRole !== role) {
      const error = new Error("当前云端账号身份与本审核页面不一致");
      error.code = "AUTH_SESSION_CHANGED";
      throw error;
    }
    if (!["hq", "operation"].includes(role)) {
      throw new Error(`当前云端业务身份为“${role || "未绑定"}”，仅总部或运营账号可以审核工单。请退出后重新登录正确账号。`);
    }
    session = {
      ...(session || {}),
      role,
      account: clean(session?.account || session?.phone),
      phone: clean(session?.phone || session?.account),
      store: profile.storeId || "",
      staffName: profile.staffName || session?.staffName || "",
      staffId: profile.staffId || session?.staffId || "",
      staffCode: profile.staffCode || session?.staffCode || staffCodeFor(role, profile.staffId || session?.staffId),
      cloudbaseUserId: data?.uid || session?.cloudbaseUserId || ""
    };
    canDecide = true;
    reviewerRole = role === "hq" ? "总部" : "运营";
    sessionStorage.setItem("prototypeSession", JSON.stringify(session));
    sessionStorage.setItem("prototypeRole", role);
    sessionStorage.setItem("prototypeAccount", session.account);
    sessionStorage.setItem("prototypeStore", session.store || "");
  }
  async function confirmReviewerIdentity() {
    const account = clean(session?.account || session?.phone);
    if (!account) throw new Error("当前页面没有有效登录会话，请退出后重新登录");
    const isLocalDemo = ["127.0.0.1", "localhost"].includes(location.hostname) && clean(session?.cloudbaseUserId).startsWith("local-demo-");
    if (isLocalDemo) {
      const role = clean(session?.role).toLowerCase();
      if (!["hq", "operation"].includes(role)) throw new Error("本地演示账号没有审核权限");
      canDecide = true;
      reviewerRole = role === "hq" ? "总部" : "运营";
      return;
    }
    if (typeof window.CloudBasePhoneAuth?.validateWorkspaceSession !== "function") throw new Error("云端身份服务未加载，请刷新页面重试");
    const data = await window.CloudBasePhoneAuth.validateWorkspaceSession(session);
    saveAuthoritativeSession(data);
  }
  function populateStoreFilter(sourceRows) {
    const selected = $("reviewStore").value || "all";
    const stores = [...new Map(sourceRows.map((row) => [row.store.id, row.store])).values()].filter((store) => store.id).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    $("reviewStore").innerHTML = `<option value="all">全部门店</option>${stores.map((store) => `<option value="${escapeHtml(store.id)}">${escapeHtml(store.name)}（${escapeHtml(store.code || store.id)}）</option>`).join("")}`;
    if ([...$("reviewStore").options].some((option) => option.value === selected)) $("reviewStore").value = selected;
  }
  function impactText(item) {
    if (pageType === "recharge") return `${item.isVoid ? "-" : "+"}${item.amount}次`;
    if (!item.isVoid) return `核销 +${item.amount || 1}`;
    return clean(pick(item.raw, "original_type", "originalType")) === "EXPERIENCE" ? "体验核销：无次数变化" : `余额 +${item.amount || 1}`;
  }
  function render() {
    $("reviewCount").innerHTML = `<strong>${rows.length}</strong><span>条符合条件</span>`;
    $("reviewBody").innerHTML = rows.map((item) => {
      const actions = item.status === "PENDING" && canDecide ? `<div class="review-actions"><button data-id="${escapeHtml(item.id)}" data-action="APPROVED">通过</button><button class="reject" data-id="${escapeHtml(item.id)}" data-action="REJECTED">驳回</button></div>` : `<span class="record-status status-${escapeHtml(statusText[item.status] || item.status)}">${escapeHtml(statusText[item.status] || item.status)}</span>`;
      const teacher = item.teacherName ? `${item.teacherName}${item.teacherId ? `（${item.teacherId}）` : ""}` : "—";
      const detailPage = pageType === "recharge" ? "recharge-detail.html" : "verification-detail.html";
      const orderCode = item.id
        ? `<a class="record-link" href="${detailPage}?recordId=${encodeURIComponent(item.id)}&recordCode=${encodeURIComponent(item.recordCode)}&source=review" title="查看${pageType === "recharge" ? "充值" : "核销"}工单 ${escapeHtml(item.recordCode)}">${escapeHtml(item.recordCode)}</a>`
        : escapeHtml(item.recordCode);
      const customerText = `${item.customerName}${item.customerId ? `（${item.customerId}）` : ""}`;
      const customerHref = item.customerCode
        ? `customer-detail.html?customerId=${encodeURIComponent(item.customerCode)}&customerName=${encodeURIComponent(item.customerName)}&storeId=${encodeURIComponent(item.store.id)}`
        : "";
      const customer = customerHref
        ? `<a class="record-link" href="${escapeHtml(customerHref)}" title="查看客户主页 ${escapeHtml(item.customerName)}">${escapeHtml(customerText)}</a>`
        : escapeHtml(customerText);
      return `<tr><td>${orderCode}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(item.store.name)}${item.store.code ? `（${escapeHtml(item.store.code)}）` : ""}</td><td>${customer}</td><td>${escapeHtml(item.project)}${item.projectId ? `（${escapeHtml(item.projectId)}）` : ""}</td><td>${escapeHtml(teacher)}</td><td>${escapeHtml(impactText(item))}</td><td>${escapeHtml(formatTime(item.time))}</td><td>${actions}</td><td>${escapeHtml(item.status === "PENDING" ? "—" : formatTime(item.reviewedAt))}</td></tr>`;
    }).join("") || `<tr><td colspan="${columnCount}" class="query-empty">当前条件下没有审核记录</td></tr>`;
    document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => openReview(button.dataset.id, button.dataset.action)));
  }
  async function refresh({ preserveStores = true } = {}) {
    if (typeof window.CloudBasePhoneAuth?.listReviewOrders !== "function") { setLoading("审核数据服务未加载，请刷新页面重试"); return; }
    const sequence = ++loadingSequence;
    setLoading("正在读取审核工单…");
    try {
      const recordCode = queryMode === "code" ? clean($("reviewCode").value).toUpperCase() : "";
      if (queryMode === "code" && !recordCode) {
        rows = [];
        setLoading(`请输入完整${pageType === "recharge" ? "充值" : "核销"}工单编号`);
        return;
      }
      const result = await window.CloudBasePhoneAuth.listReviewOrders({
        recordType,
        recordCode,
        storeId: queryMode === "filters" && $("reviewStore").value !== "all" ? $("reviewStore").value : "",
        applicationType: queryMode === "filters" ? applicationTypeFilter() : "",
        status: queryMode === "filters" && $("reviewStatus").value !== "all" ? $("reviewStatus").value.toUpperCase() : "",
        limit: queryMode === "code" ? 1 : 500
      });
      if (sequence !== loadingSequence) return;
      rows = (Array.isArray(result) ? result : []).map(normalizeRow);
      if (!preserveStores || $("reviewStore").options.length <= 1) populateStoreFilter(rows);
      render();
    } catch (error) {
      if (sequence !== loadingSequence) return;
      rows = []; setLoading(error?.message || "审核工单读取失败");
    }
  }
  function renderReviewCommunications(item) {
    const communicationRows = [{
      title: item.isVoid ? "门店作废申请留言" : "门店申请留言",
      message: item.applicantNote,
      time: item.time
    }];
    $("reviewCommunicationLog").innerHTML = communicationRows.map((row) => `<article class="communication-item"><div><strong>${escapeHtml(row.title)}</strong><time>${escapeHtml(formatTime(row.time))}</time></div><p>${escapeHtml(clean(row.message) || "无")}</p></article>`).join("");
  }
  function openReview(id, action) {
    const item = rows.find((entry) => entry.id === id); if (!item) return;
    pendingAction = { item, action };
    $("reviewDialogTitle").textContent = action === "APPROVED" ? "确认通过" : "确认驳回";
    const reviewerName = clean(session?.staffName) || reviewerRole;
    const reviewerCode = clean(session?.staffCode) || staffCodeFor(clean(session?.role).toLowerCase(), session?.staffId);
    $("reviewDialogSummary").innerHTML = `<strong>${escapeHtml(item.recordCode)} · ${escapeHtml(item.kind)}</strong><span>${escapeHtml(item.store.name)} · ${escapeHtml(item.customerName)}（${escapeHtml(item.customerId)}） · ${escapeHtml(item.project)}</span><span>审核人员：${escapeHtml(reviewerName)}${reviewerCode ? ` · ${escapeHtml(reviewerCode)}` : ""}</span>`;
    $("reviewNote").value = ""; $("confirmReview").classList.toggle("danger-button", action === "REJECTED"); renderReviewCommunications(item); $("reviewDialog").showModal();
  }
  function closeDialog() { pendingAction = null; $("reviewDialog").close(); }
  async function confirmReview() {
    if (!pendingAction || !canDecide) return;
    const note = $("reviewNote").value.trim();
    if (!window.confirm(`确认${pendingAction.action === "APPROVED" ? "通过" : "驳回"}该${pendingAction.item.kind}申请？`)) return;
    const button = $("confirmReview"); button.disabled = true; button.textContent = "正在提交…";
    try {
      await window.CloudBasePhoneAuth.reviewOrder({ recordType, recordId: pendingAction.item.id, decision: pendingAction.action, note });
      closeDialog(); await refresh();
    } catch (error) { window.alert(error?.message || "工单审核失败"); }
    finally { button.disabled = false; button.textContent = "确认"; }
  }
  function setQueryMode(mode, { initial = false } = {}) {
    queryMode = mode === "code" ? "code" : "filters";
    const codeMode = queryMode === "code";
    $("reviewFilterPanel").hidden = codeMode;
    $("reviewCodePanel").hidden = !codeMode;
    $("reviewModeFilters").classList.toggle("active", !codeMode);
    $("reviewModeCode").classList.toggle("active", codeMode);
    $("reviewModeFilters").setAttribute("aria-selected", String(!codeMode));
    $("reviewModeCode").setAttribute("aria-selected", String(codeMode));
    [$("reviewStore"), $("reviewType"), $("reviewStatus"), $("reviewFilterSearch")].forEach((field) => { field.disabled = codeMode; });
    [$("reviewCode"), $("reviewCodeSearch")].forEach((field) => { field.disabled = !codeMode; });
    if (codeMode) {
      $("reviewStore").value = "all";
      $("reviewType").value = "all";
      $("reviewStatus").value = "all";
    } else {
      $("reviewCode").value = "";
    }
    if (!initial) {
      rows = [];
      setLoading(codeMode ? "请输入完整工单编号后查询" : "选择条件后点击“按条件查询”");
      if (codeMode) $("reviewCode").focus();
    }
  }
  $("reviewStore").innerHTML = `<option value="all">全部门店</option>`;
  setQueryMode("filters", { initial: true });
  $("reviewModeFilters").addEventListener("click", () => setQueryMode("filters"));
  $("reviewModeCode").addEventListener("click", () => setQueryMode("code"));
  $("reviewFilterSearch").addEventListener("click", () => refresh());
  $("reviewCodeSearch").addEventListener("click", () => refresh());
  $("reviewCode").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); refresh(); } });
  $("closeReviewDialog").addEventListener("click", closeDialog); $("cancelReview").addEventListener("click", closeDialog); $("confirmReview").addEventListener("click", confirmReview);
  document.documentElement.dataset.prototypeVersion = VERSION;
  (async () => {
    setLoading("正在确认审核账号身份…");
    try {
      await confirmReviewerIdentity();
      await refresh({ preserveStores: false });
    } catch (error) {
      if (error?.code === "AUTH_SESSION_CHANGED") {
        ["prototypeSession", "prototypeRole", "prototypeAccount", "prototypeStore", "prototypeAccessMessage"].forEach((key) => sessionStorage.removeItem(key));
        location.replace(`login.html?reason=${encodeURIComponent(`${error.message || "当前登录身份已变更"}，请重新登录。`)}`);
        return;
      }
      rows = [];
      setLoading(error?.message || "审核账号身份确认失败，请退出后重新登录");
    }
  })();
})();

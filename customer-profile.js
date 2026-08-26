(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const customerCode = params.get("customerId") || "";
  const pageSource = String(params.get("source") || "").trim().toLowerCase();
  const reviewRecordType = String(params.get("reviewRecordType") || "").trim().toUpperCase();
  const reviewRecordId = String(params.get("reviewRecordId") || "").trim();
  const session = (() => { try { return JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { return null; } })();
  const canManageStatus = ["hq", "store"].includes(session?.role);
  const canEditNotes = ["hq", "store", "teacher"].includes(session?.role);
  const canReadPhoto = ["hq", "store", "teacher"].includes(session?.role);
  const canUseCustomerMessages = ["hq", "store", "teacher"].includes(session?.role);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  const emptyRow = (columns, text) => `<tr><td colspan="${columns}" class="query-empty">${escapeHtml(text)}</td></tr>`;
  const dateText = window.AppDateTime.formatDate || ((value) => window.AppDateTime.format(value).slice(0, 10));
  const exactDateTimeText = (value) => {
    const formatted = window.AppDateTime.format(value, "");
    const match = String(formatted || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    return match ? `${match[1]}年${match[2]}月${match[3]}日 ${match[4]}:${match[5]}:${match[6]}` : "—";
  };
  const customerMessageRoleText = (value) => ({ hq:"总部", store:"门店", teacher:"老师" }[String(value || "").toLowerCase()] || "账号");
  const birthdayText = (value) => { const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? `${match[1]}年${match[2]}月${match[3]}日` : "—"; };
  const infoCard = (label, value) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong></article>`;
  const verificationTypeText = (value) => ({ NORMAL:"正常核销", SUPPLEMENT:"补录核销", EXPERIENCE:"体验核销" }[value] || value || "正常核销");
  let profile = null, balances = [], retailProductSummary = [], recharges = [], refunds = [], verifications = [], experiences = [], requestPending = false;
  let notesEditing = false, notesPending = false, notesOriginal = "";
  let customerMessages = [], customerMessageTotal = 0, customerMessageHasMore = false, customerMessageNextCursor = null;
  let customerMessagesLoading = false, customerMessageSubmitting = false;
  let customerServiceApp = null;
  const historyState = {
    RECHARGE: { hasMore:false, nextCursor:null, loading:false },
    REFUND: { hasMore:false, nextCursor:null, loading:false },
    VERIFICATION: { hasMore:false, nextCursor:null, loading:false },
    EXPERIENCE: { hasMore:false, nextCursor:null, loading:false }
  };

  function hasReviewContext() {
    return ["RECHARGE", "VERIFICATION"].includes(reviewRecordType) && /^\d+$/.test(reviewRecordId);
  }
  function configureBackLink() {
    const link = document.querySelector(".back-link");
    if (!link) return;
    if (session?.role === "teacher") {
      link.href = "teacher-work-orders.html";
      link.textContent = "← 返回我的工作台";
      return;
    }
    if (pageSource !== "review" || session?.role !== "hq" || !hasReviewContext()) return;
    link.href = reviewRecordType === "RECHARGE" ? "recharge-review.html" : "verification-review.html";
    link.textContent = reviewRecordType === "RECHARGE" ? "← 返回充值审核" : "← 返回核销审核";
  }
  function detailHref(page, rowId, code) {
    if (!rowId || !code) return "";
    const detailParams = new URLSearchParams({ recordId:String(rowId), recordCode:String(code) });
    if (session?.role === "hq" && pageSource === "review" && hasReviewContext()) {
      detailParams.set("source", "customer");
      detailParams.set("customerId", customerCode);
      detailParams.set("reviewRecordType", reviewRecordType);
      detailParams.set("reviewRecordId", reviewRecordId);
    } else {
      detailParams.set("source", session?.role === "teacher" ? "teacher" : "query");
    }
    return `${page}?${detailParams.toString()}`;
  }

  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : null; } catch (_) { return null; }
  }
  function cloudFunctionData(result) {
    return [result?.result, result?.data?.result, result?.data, result].map(parsedObject).find((candidate) => candidate && (
      Object.prototype.hasOwnProperty.call(candidate, "ok") || Object.prototype.hasOwnProperty.call(candidate, "message") || Object.prototype.hasOwnProperty.call(candidate, "code")
    )) || {};
  }
  function registerComponent(register, componentName) {
    if (typeof register !== "function") return;
    try { register(window.cloudbase); }
    catch (error) {
      const detail = String(error?.message || error || "").toLowerCase();
      if (!(detail.includes("duplicate component") && detail.includes(componentName))) throw error;
    }
  }
  async function callCustomerService(payload) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("客户数据库组件未加载，请刷新页面后重试。");
    registerComponent(window.registerAuth, "auth"); registerComponent(window.registerFunctions, "functions");
    let result;
    try {
      customerServiceApp ||= window.cloudbase.init(window.CloudBaseAuthConfig);
      result = await customerServiceApp.callFunction({ name:"faceRecognition", data:payload });
    }
    catch (error) { throw new Error(error?.message || "客户数据库调用失败，请检查网络和登录状态。"); }
    const data = cloudFunctionData(result);
    if (!data.ok) throw new Error(data.message || "客户数据库没有返回有效结果。");
    return data;
  }
  function customerMessageLength(value) { return Array.from(String(value || "")).length; }
  function setCustomerMessageStatus(message = "", isError = false) {
    const status = $("customerMessageStatus");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", isError);
  }
  function syncCustomerMessageCounter() {
    const input = $("customerMessageInput"), counter = $("customerMessageCounter");
    if (!input || !counter) return;
    const length = customerMessageLength(input.value);
    counter.textContent = `${length}/100`;
    counter.classList.toggle("limit", length >= 100);
  }
  function syncCustomerMessageListHeight() {
    const list = $("customerMessageList");
    if (!list) return;
    list.style.removeProperty("max-height");
    if (!window.matchMedia("(min-width: 1101px)").matches) return;
    const items = Array.from(list.querySelectorAll(".customer-message-item"));
    if (items.length <= 5) return;
    const style = window.getComputedStyle(list);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const visibleHeight = items.slice(0, 5).reduce((total, item) => total + item.getBoundingClientRect().height, 0)
      + gap * 4 + padding;
    list.style.maxHeight = `${Math.ceil(visibleHeight)}px`;
  }
  function renderCustomerMessages() {
    const list = $("customerMessageList"), count = $("customerMessageCount"), loadMore = $("loadMoreCustomerMessages"), loadRow = $("customerMessageLoadRow");
    if (!list || !count || !loadMore || !loadRow) return;
    count.textContent = `${customerMessageTotal} 条`;
    list.innerHTML = customerMessages.length ? customerMessages.map((message) => {
      const author = String(message.authorName || "未命名账号");
      const role = customerMessageRoleText(message.authorRole);
      return `<article class="customer-message-item"><div class="customer-message-meta"><span class="customer-message-author">${escapeHtml(author)}<span class="customer-message-role">（${escapeHtml(role)}）</span></span><span class="customer-message-separator">：</span><time datetime="${escapeHtml(message.createdAt || "")}">${escapeHtml(exactDateTimeText(message.createdAt))}</time></div><p class="customer-message-content">${escapeHtml(message.content)}</p></article>`;
    }).join("") : '<article class="customer-message-empty">暂无客户留言</article>';
    loadMore.hidden = !customerMessageHasMore;
    loadRow.hidden = !customerMessageHasMore;
    loadMore.disabled = customerMessagesLoading;
    loadMore.textContent = customerMessagesLoading ? "正在加载…" : "加载更早留言";
    syncCustomerMessageListHeight();
  }
  async function loadCustomerMessages({ reset = false } = {}) {
    if (!canUseCustomerMessages || customerMessagesLoading || !customerCode) return;
    if (!reset && (!customerMessageHasMore || !customerMessageNextCursor)) return;
    customerMessagesLoading = true;
    if (reset) {
      customerMessages = [];
      customerMessageTotal = 0;
      customerMessageHasMore = false;
      customerMessageNextCursor = null;
      $("customerMessageList").innerHTML = '<article class="customer-message-empty">正在读取留言…</article>';
    }
    renderCustomerMessages();
    setCustomerMessageStatus(reset ? "正在读取留言…" : "正在读取更早留言…");
    try {
      const payload = { action:"listCustomerMessages", customerCode, messageLimit:20 };
      if (!reset && customerMessageNextCursor) {
        payload.cursorCreatedAt = customerMessageNextCursor.createdAt;
        payload.cursorMessageId = customerMessageNextCursor.id;
      }
      const data = await callCustomerService(payload);
      const incoming = Array.isArray(data.messages) ? data.messages : [];
      const known = new Set(customerMessages.map((message) => String(message.id)));
      incoming.forEach((message) => { if (!known.has(String(message.id))) customerMessages.push(message); });
      customerMessageTotal = Number(data.totalCount || 0);
      customerMessageHasMore = data.page?.hasMore === true;
      customerMessageNextCursor = data.page?.nextCursor || null;
      setCustomerMessageStatus("");
    } catch (error) {
      setCustomerMessageStatus(error?.message || "客户留言读取失败，请重试。", true);
    } finally {
      customerMessagesLoading = false;
      renderCustomerMessages();
    }
  }
  async function submitCustomerMessage(event) {
    event.preventDefault();
    if (!canUseCustomerMessages || customerMessageSubmitting) return;
    const input = $("customerMessageInput"), button = $("submitCustomerMessage");
    const content = String(input.value || "").replace(/\r\n?/g, "\n").trim();
    const length = customerMessageLength(content);
    if (!length) { setCustomerMessageStatus("请输入留言内容。", true); input.focus(); return; }
    if (length > 100) { setCustomerMessageStatus("单条留言不能超过 100 字。", true); input.focus(); return; }
    customerMessageSubmitting = true;
    button.disabled = true;
    setCustomerMessageStatus("正在提交留言…");
    try {
      const data = await callCustomerService({ action:"addCustomerMessage", customerCode, content });
      if (data.message && !customerMessages.some((message) => String(message.id) === String(data.message.id))) customerMessages.unshift(data.message);
      customerMessageTotal = Number(data.totalCount || customerMessages.length);
      input.value = "";
      syncCustomerMessageCounter();
      renderCustomerMessages();
      $("customerMessageList").scrollTop = 0;
      setCustomerMessageStatus("留言已保存");
    } catch (error) {
      setCustomerMessageStatus(error?.message || "客户留言提交失败，请重试。", true);
    } finally {
      customerMessageSubmitting = false;
      button.disabled = false;
    }
  }
  function orderStatus(row, recordType) {
    const status = String(row.recordStatus || "").toUpperCase();
    if (recordType === "VERIFICATION") {
      if (status === "VOIDED") return "历史已作废";
      return { PENDING:"待审核", APPROVED:"已通过", REJECTED:"已驳回" }[status] || "待审核";
    }
    const voidStatus = String(row.voidRequestStatus || "NONE").toUpperCase();
    if (status === "VOIDED" || voidStatus === "APPROVED") return "已作废";
    const base = { PENDING:"待审核", APPROVED:"已通过", REJECTED:"已驳回" }[status] || "待审核";
    if (status === "APPROVED" && voidStatus === "PENDING") return `${base} · 作废待审核`;
    if (status === "APPROVED" && voidStatus === "REJECTED") return `${base} · 作废已驳回`;
    return base;
  }
  function renderBasic() {
    const store = [profile.storeName, profile.storeCode].filter(Boolean).join(" · ") || "—";
    $("customerBasicInfo").innerHTML = [
      infoCard("客户姓名", profile.customerName), infoCard("客户编号", profile.customerCode),
      infoCard("生日", birthdayText(profile.birthDate)), infoCard("所属门店", store)
    ].join("");
    $("customerNotes").value = profile.notes || "";
    notesOriginal = profile.notes || "";
    renderNotesControls();
    document.title = profile.customerName ? `${profile.customerName} · 客户主页` : "客户主页";
  }
  function renderNotesControls(message = "", isError = false) {
    const textarea = $("customerNotes");
    textarea.readOnly = !notesEditing || notesPending;
    $("editCustomerNotes").hidden = !canEditNotes || notesEditing;
    $("saveCustomerNotes").hidden = !canEditNotes || !notesEditing;
    $("cancelCustomerNotes").hidden = !canEditNotes || !notesEditing;
    $("saveCustomerNotes").disabled = notesPending;
    $("cancelCustomerNotes").disabled = notesPending;
    const status = $("customerNotesMessage");
    status.textContent = message;
    status.classList.toggle("error", isError);
  }
  function editCustomerNotes() {
    if (!canEditNotes || !profile || notesPending) return;
    notesOriginal = profile.notes || "";
    notesEditing = true;
    renderNotesControls();
    $("customerNotes").focus();
  }
  function cancelCustomerNotes() {
    if (notesPending) return;
    $("customerNotes").value = notesOriginal;
    notesEditing = false;
    renderNotesControls();
  }
  async function saveCustomerNotes() {
    if (!canEditNotes || !profile || notesPending) return;
    const notes = $("customerNotes").value.replace(/\r\n?/g, "\n").trim();
    if (notes.length > 5000) { renderNotesControls("客户备注不能超过 5000 个字符。", true); return; }
    notesPending = true;
    renderNotesControls("正在保存…");
    try {
      const data = await callCustomerService({ action:"updateCustomerNotes", customerCode, expectedNotes:notesOriginal, notes });
      profile.notes = data.customer?.notes ?? notes;
      notesOriginal = profile.notes;
      $("customerNotes").value = profile.notes;
      notesEditing = false;
      notesPending = false;
      renderNotesControls("已保存");
    } catch (error) {
      notesPending = false;
      renderNotesControls(error.message || "客户备注保存失败。", true);
    }
  }
  function renderRecent(message = "", isError = false) {
    const archived = profile.customerStatus === "ARCHIVED";
    $("customerRecentInfo").innerHTML = `<article><span>最近充值时间</span><strong>${escapeHtml(dateText(profile.latestRechargeAt))}</strong></article><article><span>最近核销时间</span><strong>${escapeHtml(dateText(profile.latestVerificationAt))}</strong></article><article><span>客户建立时间</span><strong>${escapeHtml(dateText(profile.createdAt))}</strong></article><article class="customer-status-cell"><span>客户状态</span><div class="customer-status-actions"><span class="record-status ${archived ? "status-已作废" : "status-正常"}">${archived ? "已封存" : "活跃"}</span><button id="customerStatusToggle" type="button" class="${archived ? "customer-status-activate" : "danger-button"}" ${canManageStatus ? "" : "hidden"} ${requestPending ? "disabled" : ""}>${archived ? "激活客户" : "封存客户"}</button></div></article>`;
    $("customerStatusMessage").textContent = message;
    $("customerStatusMessage").classList.toggle("error", isError);
    $("customerStatusToggle")?.addEventListener("click", toggleCustomerStatus);
  }
  function renderBalances() {
    $("customerProjectSummary").innerHTML = balances.length ? balances.map((row) => `<tr><td>${escapeHtml(row.productName)}</td><td>${Number(row.totalRechargeCount || 0)}</td><td>${Number(row.totalVerificationCount || 0)}</td><td><strong>${Number(row.remainingCount || 0)}</strong></td></tr>`).join("") : emptyRow(4, "暂无已充值项目");
    $("customerRetailProductSummary").innerHTML = retailProductSummary.length
      ? retailProductSummary.map((row) => `<tr><td>${escapeHtml(row.productName)}</td><td>${Number(row.purchasedCount || 0)} 件</td><td>${Number(row.giftedCount || 0)} 件</td></tr>`).join("")
      : emptyRow(3, "暂无产品购买或赠送记录");
  }
  function businessTeacher(row) {
    const name = String(row?.teacherName || "").trim();
    if (!name) return "";
    const code = String(row?.teacherCode || "").trim();
    return code ? `${name} · ${code}` : name;
  }
  function renderRecords() {
    $("customerRechargeRecords").innerHTML = recharges.length ? recharges.map((row) => {
      const units = Number(row.unitCount || 0);
      const code = row.rechargeCode || row.id;
      const detail = detailHref("recharge-detail.html", row.id, code);
      const codeCell = detail ? `<a class="record-link" href="${escapeHtml(detail)}">${escapeHtml(code)}</a>` : escapeHtml(code);
      return `<tr><td>${codeCell}</td><td>${escapeHtml(row.productName)}</td><td>+${units}</td><td>${escapeHtml(businessTeacher(row))}</td><td>${escapeHtml(dateText(row.submittedAt))}</td><td>${escapeHtml(orderStatus(row, "RECHARGE"))}</td></tr>`;
    }).join("") : emptyRow(6, "暂无充值记录");
    $("customerRefundRecords").innerHTML = refunds.length ? refunds.map((row) => {
      const units = Math.abs(Number(row.unitCount || 0));
      const code = row.rechargeCode || row.id;
      const detail = detailHref("recharge-detail.html", row.id, code);
      const codeCell = detail ? `<a class="record-link" href="${escapeHtml(detail)}">${escapeHtml(code)}</a>` : escapeHtml(code);
      return `<tr><td>${codeCell}</td><td>${escapeHtml(row.productName)}</td><td>−${units}</td><td>${escapeHtml(businessTeacher(row))}</td><td>${escapeHtml(dateText(row.submittedAt))}</td><td>${escapeHtml(orderStatus(row, "RECHARGE"))}</td></tr>`;
    }).join("") : emptyRow(6, "暂无退费记录");
    $("customerVerificationRecords").innerHTML = verifications.length ? verifications.map((row) => {
      const code = row.verificationCode || row.id;
      const detail = detailHref("verification-detail.html", row.id, code);
      const codeCell = detail ? `<a class="record-link" href="${escapeHtml(detail)}">${escapeHtml(code)}</a>` : escapeHtml(code);
      return `<tr><td>${codeCell}</td><td>${escapeHtml(row.productName)}</td><td>${escapeHtml(businessTeacher(row))}</td><td>${escapeHtml(dateText(row.submittedAt))}</td></tr>`;
    }).join("") : emptyRow(4, "暂无核销记录");
    $("customerExperienceRecords").innerHTML = experiences.length ? experiences.map((row) => {
      const code = row.verificationCode || row.id;
      const detail = detailHref("verification-detail.html", row.id, code);
      const codeCell = detail ? `<a class="record-link" href="${escapeHtml(detail)}">${escapeHtml(code)}</a>` : escapeHtml(code);
      return `<tr><td>${codeCell}</td><td>${escapeHtml(row.productName)}</td><td>${escapeHtml(businessTeacher(row))}</td><td>${escapeHtml(dateText(row.submittedAt))}</td></tr>`;
    }).join("") : emptyRow(4, "暂无体验记录");
    syncHistoryButton("RECHARGE");
    syncHistoryButton("REFUND");
    syncHistoryButton("VERIFICATION");
    syncHistoryButton("EXPERIENCE");
  }
  function historyKey(row) { return String(row?.id || ""); }
  function syncHistoryButton(type) {
    const button = $({ RECHARGE:"loadMoreRecharges", REFUND:"loadMoreRefunds", VERIFICATION:"loadMoreVerifications", EXPERIENCE:"loadMoreExperiences" }[type]);
    if (!button) return;
    const state = historyState[type];
    button.hidden = !state.hasMore;
    button.disabled = state.loading;
    button.textContent = state.loading ? "正在加载…" : "加载更多";
  }
  function profilePayload(extra = {}) { return { action:"getCustomerProfile", customerCode, ...extra }; }
  async function loadMoreHistory(type) {
    const state = historyState[type];
    if (!state?.hasMore || state.loading || !state.nextCursor) return;
    state.loading = true; syncHistoryButton(type);
    try {
      const data = await callCustomerService(profilePayload({
        historyType:type,
        historyLimit:50,
        cursorSubmittedAt:state.nextCursor.submittedAt,
        cursorId:state.nextCursor.id
      }));
      const field = { RECHARGE:"recharges", REFUND:"refunds", VERIFICATION:"verifications", EXPERIENCE:"experiences" }[type];
      const page = data.history?.[field] || {};
      const incoming = Array.isArray(data[field]) ? data[field] : [];
      const target = { RECHARGE:recharges, REFUND:refunds, VERIFICATION:verifications, EXPERIENCE:experiences }[type];
      const known = new Set(target.map(historyKey));
      incoming.forEach((row) => { if (!known.has(historyKey(row))) target.push(row); });
      state.hasMore = page.hasMore === true;
      state.nextCursor = page.nextCursor || null;
      renderRecords();
    } catch (error) {
      window.alert(error?.message || "客户历史记录加载失败，请重试。");
    } finally {
      state.loading = false; syncHistoryButton(type);
    }
  }
  function renderPhoto(content, error = false) {
    const frame = $("customerProfilePhoto"); frame.classList.toggle("customer-photo-error", error); frame.innerHTML = content;
  }
  async function loadPhoto() {
    if (!canReadPhoto || !customerCode) { renderPhoto('<div class="customer-photo-placeholder">当前身份不显示客户照片</div>'); return; }
    renderPhoto('<div class="customer-photo-placeholder">正在从私有存储读取照片…</div>');
    try {
      const data = await callCustomerService({ action:"getCustomerPhotoUrl", customerCode });
      const url = String(data.photoUrl || "").trim(); if (!/^https:\/\//i.test(url)) throw new Error("客户照片临时地址无效。");
      renderPhoto(`<img id="customerProfilePhotoImage" src="${escapeHtml(url)}" alt="${escapeHtml(profile?.customerName || "客户")}的建档照片" referrerpolicy="no-referrer" decoding="async" fetchpriority="high">`);
      $("customerProfilePhotoImage").addEventListener("error", () => renderPhoto('<div class="customer-photo-placeholder">照片读取失败，请刷新重试</div>', true), { once:true });
    } catch (error) { renderPhoto(`<div class="customer-photo-placeholder">${escapeHtml(error.message || "照片读取失败")}</div>`, true); }
  }
  async function toggleCustomerStatus() {
    if (requestPending || !canManageStatus || !profile) return;
    const targetStatus = profile.customerStatus === "ARCHIVED" ? "ACTIVE" : "ARCHIVED";
    const verb = targetStatus === "ARCHIVED" ? "封存" : "激活";
    if (!window.confirm(`${verb}客户 ${profile.customerName}？`)) return;
    requestPending = true; renderRecent(`正在${verb}客户…`);
    try {
      const data = await callCustomerService({ action:"updateCustomerStatus", customerCode, expectedStatus:profile.customerStatus, targetStatus });
      profile.customerStatus = data.customer?.customerStatus || targetStatus;
      requestPending = false; renderRecent(`客户已${verb}，数据库状态已更新。`);
    } catch (error) { requestPending = false; renderRecent(error.message || `客户${verb}失败。`, true); }
  }
  function renderLoadError(message) {
    $("customerBasicInfo").innerHTML = infoCard("读取失败", message);
    $("customerRecentInfo").innerHTML = ""; $("customerNotes").value = "";
    $("customerStatusMessage").textContent = message; $("customerStatusMessage").classList.add("error");
    $("customerProjectSummary").innerHTML = emptyRow(4, "客户项目数据读取失败");
    $("customerRetailProductSummary").innerHTML = emptyRow(3, "客户产品数据读取失败");
    $("customerRechargeRecords").innerHTML = emptyRow(6, "充值记录读取失败");
    $("customerRefundRecords").innerHTML = emptyRow(6, "退费记录读取失败");
    $("customerVerificationRecords").innerHTML = emptyRow(4, "核销记录读取失败");
    $("customerExperienceRecords").innerHTML = emptyRow(4, "体验记录读取失败");
    ["loadMoreRecharges", "loadMoreRefunds", "loadMoreVerifications", "loadMoreExperiences"].forEach((id) => { if ($(id)) $(id).hidden = true; });
    if (canUseCustomerMessages) {
      $("customerMessageList").innerHTML = `<article class="customer-message-empty">${escapeHtml(message)}</article>`;
      $("loadMoreCustomerMessages").hidden = true;
      $("customerMessageLoadRow").hidden = true;
      setCustomerMessageStatus(message, true);
    }
    renderPhoto('<div class="customer-photo-placeholder">客户资料读取失败</div>', true);
  }
  async function loadProfile() {
    if (!customerCode) { renderLoadError("缺少客户编号，请返回客户查询重新进入。"); return; }
    $("customerBasicInfo").innerHTML = infoCard("数据库状态", "正在读取客户主页…");
    void loadPhoto();
    try {
      const data = await callCustomerService(profilePayload({ historyLimit:50 }));
      profile = data.customer; balances = Array.isArray(data.balances) ? data.balances : [];
      retailProductSummary = Array.isArray(data.retailProductSummary) ? data.retailProductSummary : [];
      recharges = Array.isArray(data.recharges) ? data.recharges : []; refunds = Array.isArray(data.refunds) ? data.refunds : []; verifications = Array.isArray(data.verifications) ? data.verifications : []; experiences = Array.isArray(data.experiences) ? data.experiences : [];
      historyState.RECHARGE.hasMore = data.history?.recharges?.hasMore === true;
      historyState.RECHARGE.nextCursor = data.history?.recharges?.nextCursor || null;
      historyState.REFUND.hasMore = data.history?.refunds?.hasMore === true;
      historyState.REFUND.nextCursor = data.history?.refunds?.nextCursor || null;
      historyState.VERIFICATION.hasMore = data.history?.verifications?.hasMore === true;
      historyState.VERIFICATION.nextCursor = data.history?.verifications?.nextCursor || null;
      historyState.EXPERIENCE.hasMore = data.history?.experiences?.hasMore === true;
      historyState.EXPERIENCE.nextCursor = data.history?.experiences?.nextCursor || null;
      renderBasic(); renderRecent(); renderBalances(); renderRecords();
      void loadCustomerMessages({ reset:true });
    } catch (error) { renderLoadError(error.message || "客户主页数据库读取失败，请刷新重试。"); }
  }
  configureBackLink();
  if (!canUseCustomerMessages) $("customerMessagesPanel").hidden = true;
  $("loadMoreRecharges")?.addEventListener("click", () => loadMoreHistory("RECHARGE"));
  $("loadMoreRefunds")?.addEventListener("click", () => loadMoreHistory("REFUND"));
  $("loadMoreVerifications")?.addEventListener("click", () => loadMoreHistory("VERIFICATION"));
  $("loadMoreExperiences")?.addEventListener("click", () => loadMoreHistory("EXPERIENCE"));
  $("loadMoreCustomerMessages")?.addEventListener("click", () => loadCustomerMessages());
  $("customerMessageForm")?.addEventListener("submit", submitCustomerMessage);
  $("customerMessageInput")?.addEventListener("input", syncCustomerMessageCounter);
  window.addEventListener("resize", syncCustomerMessageListHeight);
  $("editCustomerNotes")?.addEventListener("click", editCustomerNotes);
  $("saveCustomerNotes")?.addEventListener("click", saveCustomerNotes);
  $("cancelCustomerNotes")?.addEventListener("click", cancelCustomerNotes);
  syncCustomerMessageCounter();
  void loadProfile();
})();

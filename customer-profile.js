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
  const canReadPhoto = ["hq", "store"].includes(session?.role);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  const emptyRow = (columns, text) => `<tr><td colspan="${columns}" class="query-empty">${escapeHtml(text)}</td></tr>`;
  const dateText = window.AppDateTime.format;
  const birthdayText = (value) => { const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? `${match[1]}年${match[2]}月${match[3]}日` : "—"; };
  const infoCard = (label, value) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong></article>`;
  const verificationTypeText = (value) => ({ NORMAL:"正常核销", SUPPLEMENT:"补录核销", EXPERIENCE:"体验核销" }[value] || value || "正常核销");
  let profile = null, balances = [], recharges = [], verifications = [], requestPending = false;
  let customerServiceApp = null;
  const historyState = {
    RECHARGE: { hasMore:false, nextCursor:null, loading:false },
    VERIFICATION: { hasMore:false, nextCursor:null, loading:false }
  };

  function hasReviewContext() {
    return ["RECHARGE", "VERIFICATION"].includes(reviewRecordType) && /^\d+$/.test(reviewRecordId);
  }
  function configureBackLink() {
    const link = document.querySelector(".back-link");
    if (!link || pageSource !== "review" || !["hq", "operation"].includes(session?.role) || !hasReviewContext()) return;
    link.href = reviewRecordType === "RECHARGE" ? "recharge-review.html" : "verification-review.html";
    link.textContent = reviewRecordType === "RECHARGE" ? "← 返回充值审核" : "← 返回核销审核";
  }
  function detailHref(page, rowId, code) {
    if (!rowId || !code) return "";
    const detailParams = new URLSearchParams({ recordId:String(rowId), recordCode:String(code) });
    if (["hq", "operation"].includes(session?.role) && pageSource === "review" && hasReviewContext()) {
      detailParams.set("source", "customer");
      detailParams.set("customerId", customerCode);
      detailParams.set("reviewRecordType", reviewRecordType);
      detailParams.set("reviewRecordId", reviewRecordId);
    } else {
      detailParams.set("source", "query");
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
  function orderStatus(row) {
    const status = String(row.recordStatus || "").toUpperCase();
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
    document.title = profile.customerName ? `${profile.customerName} · 客户主页` : "客户主页";
  }
  function renderRecent(message = "", isError = false) {
    const archived = profile.customerStatus === "ARCHIVED";
    $("customerRecentInfo").innerHTML = `<article><span>最近充值时间</span><strong>${escapeHtml(dateText(profile.latestRechargeAt))}</strong></article><article><span>最近核销时间</span><strong>${escapeHtml(dateText(profile.latestVerificationAt))}</strong></article><article><span>客户建立时间</span><strong>${escapeHtml(dateText(profile.createdAt))}</strong></article><article class="customer-status-cell"><span>客户状态</span><div class="customer-status-actions"><span class="record-status ${archived ? "status-已作废" : "status-正常"}">${archived ? "已封存" : "活跃"}</span><button id="customerStatusToggle" type="button" class="${archived ? "customer-status-activate" : "danger-button"}" ${canManageStatus ? "" : "hidden"} ${requestPending ? "disabled" : ""}>${archived ? "激活客户" : "封存客户"}</button></div></article>`;
    $("customerStatusMessage").textContent = message;
    $("customerStatusMessage").classList.toggle("error", isError);
    $("customerStatusToggle")?.addEventListener("click", toggleCustomerStatus);
  }
  function renderBalances() {
    $("customerProjectSummary").innerHTML = balances.length ? balances.map((row) => `<tr><td>${escapeHtml(row.productName)}${row.productCode ? ` · ${escapeHtml(row.productCode)}` : ""}</td><td>${Number(row.totalRechargeCount || 0)}</td><td>${Number(row.totalVerificationCount || 0)}</td><td><strong>${Number(row.remainingCount || 0)}</strong></td></tr>`).join("") : emptyRow(4, "暂无已充值项目");
  }
  function renderRecords() {
    $("customerRechargeRecords").innerHTML = recharges.length ? recharges.map((row) => {
      const units = Number(row.unitCount || 0), prefix = row.rechargeType === "VOID" ? "−" : "+";
      const code = row.rechargeCode || row.id;
      const detail = detailHref("recharge-detail.html", row.id, code);
      const codeCell = detail ? `<a class="record-link" href="${escapeHtml(detail)}">${escapeHtml(code)}</a>` : escapeHtml(code);
      return `<tr><td>${codeCell}</td><td>${escapeHtml([row.productName, row.productCode].filter(Boolean).join(" · "))}</td><td>${prefix}${units}</td><td>${escapeHtml(dateText(row.submittedAt))}</td><td>${escapeHtml(orderStatus(row))}</td></tr>`;
    }).join("") : emptyRow(5, "暂无充值记录");
    $("customerVerificationRecords").innerHTML = verifications.length ? verifications.map((row) => {
      const code = row.verificationCode || row.id;
      const operationCanOpen = session?.role !== "operation"
        || String(row.voidRequestStatus || "NONE").toUpperCase() !== "NONE"
        || String(row.verificationType || "").toUpperCase() === "SUPPLEMENT";
      const detail = operationCanOpen ? detailHref("verification-detail.html", row.id, code) : "";
      const codeCell = detail ? `<a class="record-link" href="${escapeHtml(detail)}">${escapeHtml(code)}</a>` : escapeHtml(code);
      return `<tr><td>${codeCell}</td><td>${escapeHtml([row.productName, row.productCode].filter(Boolean).join(" · "))}</td><td>${escapeHtml(verificationTypeText(row.verificationType))}</td><td>${escapeHtml(dateText(row.submittedAt))}</td><td>${escapeHtml(orderStatus(row))}</td></tr>`;
    }).join("") : emptyRow(5, "暂无核销记录");
    syncHistoryButton("RECHARGE");
    syncHistoryButton("VERIFICATION");
  }
  function historyKey(row) { return String(row?.id || ""); }
  function syncHistoryButton(type) {
    const button = $(type === "RECHARGE" ? "loadMoreRecharges" : "loadMoreVerifications");
    if (!button) return;
    const state = historyState[type];
    button.hidden = !state.hasMore;
    button.disabled = state.loading;
    button.textContent = state.loading ? "正在加载…" : "加载更多";
  }
  function profilePayload(extra = {}) {
    return session?.role === "operation"
      ? { action:"getReviewCustomerProfile", customerCode, reviewRecordType, reviewRecordId, ...extra }
      : { action:"getCustomerProfile", customerCode, ...extra };
  }
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
      const field = type === "RECHARGE" ? "recharges" : "verifications";
      const page = data.history?.[field] || {};
      const incoming = Array.isArray(data[field]) ? data[field] : [];
      const target = type === "RECHARGE" ? recharges : verifications;
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
    $("customerRechargeRecords").innerHTML = emptyRow(5, "充值记录读取失败");
    $("customerVerificationRecords").innerHTML = emptyRow(5, "核销记录读取失败");
    ["loadMoreRecharges", "loadMoreVerifications"].forEach((id) => { if ($(id)) $(id).hidden = true; });
    renderPhoto('<div class="customer-photo-placeholder">客户资料读取失败</div>', true);
  }
  async function loadProfile() {
    if (!customerCode) { renderLoadError("缺少客户编号，请返回客户查询重新进入。"); return; }
    if (session?.role === "operation" && !hasReviewContext()) { renderLoadError("运营账号必须从审核记录进入客户主页。"); return; }
    $("customerBasicInfo").innerHTML = infoCard("数据库状态", "正在读取客户主页…");
    void loadPhoto();
    try {
      const data = await callCustomerService(profilePayload({ historyLimit:50 }));
      profile = data.customer; balances = Array.isArray(data.balances) ? data.balances : [];
      recharges = Array.isArray(data.recharges) ? data.recharges : []; verifications = Array.isArray(data.verifications) ? data.verifications : [];
      historyState.RECHARGE.hasMore = data.history?.recharges?.hasMore === true;
      historyState.RECHARGE.nextCursor = data.history?.recharges?.nextCursor || null;
      historyState.VERIFICATION.hasMore = data.history?.verifications?.hasMore === true;
      historyState.VERIFICATION.nextCursor = data.history?.verifications?.nextCursor || null;
      renderBasic(); renderRecent(); renderBalances(); renderRecords();
    } catch (error) { renderLoadError(error.message || "客户主页数据库读取失败，请刷新重试。"); }
  }
  configureBackLink();
  $("loadMoreRecharges")?.addEventListener("click", () => loadMoreHistory("RECHARGE"));
  $("loadMoreVerifications")?.addEventListener("click", () => loadMoreHistory("VERIFICATION"));
  void loadProfile();
})();

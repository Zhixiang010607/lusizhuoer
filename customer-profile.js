(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const customerCode = new URLSearchParams(location.search).get("customerId") || "";
  const session = (() => { try { return JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { return null; } })();
  const canManageStatus = ["hq", "store"].includes(session?.role);
  const canReadPhoto = ["hq", "store"].includes(session?.role);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  const emptyRow = (columns, text) => `<tr><td colspan="${columns}" class="query-empty">${escapeHtml(text)}</td></tr>`;
  const dateText = (value) => value ? String(value).replace("T", " ").replace(/\.\d+(?:Z|[+-]\d\d:\d\d)?$/, "").slice(0, 16) : "—";
  const birthdayText = (value) => { const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? `${match[1]}年${match[2]}月${match[3]}日` : "—"; };
  const infoCard = (label, value) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong></article>`;
  const verificationTypeText = (value) => ({ NORMAL:"正常核销", SUPPLEMENT:"补录核销", EXPERIENCE:"体验核销" }[value] || value || "正常核销");
  let profile = null, balances = [], recharges = [], verifications = [], requestPending = false;

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
    try { result = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({ name:"faceRecognition", data:payload }); }
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
      return `<tr><td>${escapeHtml(row.rechargeCode || row.id)}</td><td>${escapeHtml([row.productName, row.productCode].filter(Boolean).join(" · "))}</td><td>${prefix}${units}</td><td>${escapeHtml(dateText(row.submittedAt))}</td><td>${escapeHtml(orderStatus(row))}</td></tr>`;
    }).join("") : emptyRow(5, "暂无充值记录");
    $("customerVerificationRecords").innerHTML = verifications.length ? verifications.map((row) => `<tr><td>${escapeHtml(row.verificationCode || row.id)}</td><td>${escapeHtml([row.productName, row.productCode].filter(Boolean).join(" · "))}</td><td>${escapeHtml(verificationTypeText(row.verificationType))}</td><td>${escapeHtml(dateText(row.submittedAt))}</td><td>${escapeHtml(orderStatus(row))}</td></tr>`).join("") : emptyRow(5, "暂无核销记录");
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
      renderPhoto(`<img id="customerProfilePhotoImage" src="${escapeHtml(url)}" alt="${escapeHtml(profile?.customerName || "客户")}的建档照片" referrerpolicy="no-referrer">`);
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
    renderPhoto('<div class="customer-photo-placeholder">客户资料读取失败</div>', true);
  }
  async function loadProfile() {
    if (!customerCode) { renderLoadError("缺少客户编号，请返回客户查询重新进入。"); return; }
    $("customerBasicInfo").innerHTML = infoCard("数据库状态", "正在读取客户主页…");
    try {
      const data = await callCustomerService({ action:"getCustomerProfile", customerCode });
      profile = data.customer; balances = Array.isArray(data.balances) ? data.balances : [];
      recharges = Array.isArray(data.recharges) ? data.recharges : []; verifications = Array.isArray(data.verifications) ? data.verifications : [];
      renderBasic(); renderRecent(); renderBalances(); renderRecords(); void loadPhoto();
    } catch (error) { renderLoadError(error.message || "客户主页数据库读取失败，请刷新重试。"); }
  }
  void loadProfile();
})();

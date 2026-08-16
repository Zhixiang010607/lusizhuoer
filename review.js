(() => {
  "use strict";
  const VERSION = "0.14.19", type = document.body.dataset.review, $ = (id) => document.getElementById(id);
  let createdStores = [];
  try { createdStores = JSON.parse(sessionStorage.getItem("prototypeCreatedStores") || "[]"); } catch (_) { createdStores = []; }
  const stores = createdStores.map((store) => ({ id: store.id, name: store.name || store.id }));
  let session = null, pendingAction = null; try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  const canDecide = ["operation", "hq"].includes(session?.role);
  const reviewerRole = session?.role === "hq" ? "总部" : "运营";
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const normalizeStatus = (status) => ({ "待审核": "pending", "已通过": "approved", "已驳回": "rejected" }[status] || status || "pending");
  const storeFor = (storeId) => stores.find((store) => store.id === storeId) || { id: storeId || "", name: storeId || "未绑定门店" };
  let stored = [];
  try {
    if (type === "verification") {
      stored = JSON.parse(sessionStorage.getItem("prototypeVerificationReviewApplications") || "[]").map((item) => ({ ...item, store: storeFor(item.storeId), status: normalizeStatus(item.status), time: item.time || item.createdAt || "", sourceKey: "prototypeVerificationReviewApplications" }));
    } else {
      stored = JSON.parse(sessionStorage.getItem("prototypeRechargeApplications") || "[]").map((item) => ({ id: item.id, kind: item.kind || "新充值", recordId: item.recordId || item.id, storeId: item.storeId, store: storeFor(item.storeId), customerId: item.customerId, customerName: item.customerName || item.name, projectId: item.projectId, project: item.projectName || item.project || item.projectId || "", teacherId: item.teacherId || "", amount: Number(item.count || item.unitCount || 1), applicantNote: item.note || "", status: normalizeStatus(item.status), time: item.createdAt || item.time || "", reviewedAt: item.reviewedAt, sourceKey: "prototypeRechargeApplications" }));
    }
  } catch (_) { stored = []; }
  const items = stored, statusText = { pending: "待审核", approved: "已通过", rejected: "已驳回" };
  const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const formatTime = (value) => String(value).replace("T", " ").replace(/\.\d{3}Z$/, "").slice(0, 19);
  const approvalTime = (item) => item.status === "pending" ? "待批准" : item.reviewedAt ? formatTime(item.reviewedAt) : "未记录";
  function applyTimeRange() {
    const range = $("reviewTimeRange").value, today = new Date(), start = new Date(today);
    if (range === "all") { $("reviewDateStart").value = ""; $("reviewDateEnd").value = ""; $("reviewDateStart").disabled = true; $("reviewDateEnd").disabled = true; return; }
    if (range === "sevenDays") start.setDate(today.getDate() - 6);
    else if (range === "month") start.setMonth(today.getMonth() - 1);
    else if (range === "quarter") start.setMonth(Math.floor(today.getMonth() / 3) * 3, 1);
    else if (range === "year") start.setMonth(0, 1);
    if (range !== "custom" || !$("reviewDateStart").value || !$("reviewDateEnd").value) { $("reviewDateStart").value = isoDate(start); $("reviewDateEnd").value = isoDate(today); }
    $("reviewDateStart").disabled = range !== "custom"; $("reviewDateEnd").disabled = range !== "custom";
  }
  const link = (page, key, value, label) => session?.role === "hq" ? `<a class="record-link" href="${page}?${key}=${encodeURIComponent(value)}">${label}</a>` : label;
  const loadCommunications = () => { try { return JSON.parse(sessionStorage.getItem("prototypeCommunications") || "[]"); } catch (_) { return []; } };
  const saveCommunications = (rows) => { try { sessionStorage.setItem("prototypeCommunications", JSON.stringify(rows)); } catch (_) { /* 静态演示 */ } };
  function render() {
    const start = $("reviewDateStart").value, end = $("reviewDateEnd").value;
    const rows = items.filter((item) => ($("reviewStore").value === "all" || item.store.id === $("reviewStore").value) && ($("reviewType").value === "all" || item.kind === $("reviewType").value) && ($("reviewStatus").value === "all" || item.status === $("reviewStatus").value) && (!start || item.time.slice(0, 10) >= start) && (!end || item.time.slice(0, 10) <= end)).sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || String(b.time).localeCompare(String(a.time)));
    $("reviewCount").innerHTML = `<strong>${rows.length}</strong><span>条符合条件</span>`;
    $("reviewBody").innerHTML = rows.map((item) => {
      const actions = item.status === "pending" && canDecide ? `<div class="review-actions"><button data-id="${item.id}" data-action="approved">批准</button><button class="reject" data-id="${item.id}" data-action="rejected">拒绝</button></div>` : item.status === "pending" ? `<span class="record-status status-审核中">仅运营可审批</span>` : `<span class="record-status status-${statusText[item.status]}">${statusText[item.status]}</span>`;
      const detailParams = `recordId=${encodeURIComponent(item.recordId)}&customerId=${encodeURIComponent(item.customerId)}&customerName=${encodeURIComponent(item.customerName)}&storeId=${encodeURIComponent(item.store.id)}&kind=${encodeURIComponent(item.kind)}`;
      if (type === "recharge") return `<tr><td>${item.id}</td><td>${item.kind}</td><td><a class="record-link" href="recharge-detail.html?${detailParams}">${item.recordId}</a></td><td>${link("store-detail.html", "storeId", item.store.id, item.store.name)}</td><td>${item.customerName}（${item.customerId}）</td><td>${item.project}</td><td>${item.teacherId || "—"}</td><td>${item.kind === "作废充值" ? `-${item.amount}次` : `+${item.amount}次`}</td><td>${item.time ? formatTime(item.time) : "未记录"}</td><td>${statusText[item.status]}</td><td>${actions}</td><td>${approvalTime(item)}</td></tr>`;
      const impact = item.kind === "补录" ? "核销 +1" : "核销 -1 / 余额 +1";
      return `<tr><td>${item.id}</td><td>${item.kind}</td><td><a class="record-link" href="verification-detail.html?${detailParams}">${item.recordId}</a></td><td>${item.store.name}</td><td>${item.customerName}（${item.customerId}）</td><td>${item.project}</td><td>${item.teacherId}</td><td>${impact}</td><td>${item.time ? formatTime(item.time) : "未记录"}</td><td>${statusText[item.status]}</td><td>${actions}</td><td>${approvalTime(item)}</td></tr>`;
    }).join("") || `<tr><td colspan="12" class="query-empty">当前条件下没有审核记录</td></tr>`;
    document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => openReview(button.dataset.id, button.dataset.action)));
  }
  function renderReviewCommunications(item) {
    const applicantMessage = item.applicantNote || "提交审核申请", extra = loadCommunications().filter((row) => row.recordType === type && row.recordId === item.recordId && row.message !== applicantMessage);
    const rows = [{ role: "门店", name: "门店人员", message: applicantMessage, time: item.time }, ...extra];
    $("reviewCommunicationLog").innerHTML = rows.map((row) => `<article class="communication-item"><div><strong>${escapeHtml(row.role)} · ${escapeHtml(row.name)}</strong><time>${escapeHtml(row.time)}</time></div><p>${escapeHtml(row.message)}</p></article>`).join("");
    $("reviewCommunicationLog").scrollTop = $("reviewCommunicationLog").scrollHeight;
  }
  function openReview(id, action) { const item = items.find((entry) => entry.id === id); pendingAction = { item, action }; $("reviewDialogTitle").textContent = action === "approved" ? "确认批准" : "确认拒绝"; $("reviewDialogSummary").innerHTML = `<strong>${item.id} · ${item.kind}</strong><span>${item.store.name} · ${item.customerName} · ${item.project}</span><span>审批账号：${session.account} · ${reviewerRole}人员</span>`; $("reviewNote").value = ""; $("confirmReview").classList.toggle("danger-button", action === "rejected"); renderReviewCommunications(item); $("reviewDialog").showModal(); }
  function closeDialog() { pendingAction = null; $("reviewDialog").close(); }
  function organizeReviewToolbar() {
    const toolbar = document.querySelector(".review-toolbar"), count = $("reviewCount");
    if (!toolbar || !count || toolbar.querySelector(".review-filter-row")) return;
    const basicRow = document.createElement("div"), dateRow = document.createElement("div");
    basicRow.className = "review-filter-row review-basic-row";
    dateRow.className = "review-filter-row review-date-row";
    [$("reviewStore"), $("reviewType"), $("reviewStatus")].forEach((field) => basicRow.append(field.closest("label")));
    [$("reviewTimeRange"), $("reviewDateStart"), $("reviewDateEnd")].forEach((field) => dateRow.append(field.closest("label")));
    dateRow.append(count);
    toolbar.append(basicRow, dateRow);
  }
  organizeReviewToolbar();
  $("reviewStore").innerHTML = `<option value="all">全部门店</option>${stores.map((store) => `<option value="${store.id}">${store.name}（${store.id}）</option>`).join("")}`; document.querySelector(".review-table thead tr")?.insertAdjacentHTML("beforeend", "<th>批准/驳回时间</th>"); applyTimeRange();
  ["reviewStore", "reviewType", "reviewStatus"].forEach((id) => $(id).addEventListener("change", render)); $("reviewTimeRange").addEventListener("change", () => { applyTimeRange(); render(); }); ["reviewDateStart", "reviewDateEnd"].forEach((id) => $(id).addEventListener("change", render)); $("closeReviewDialog").addEventListener("click", closeDialog); $("cancelReview").addEventListener("click", closeDialog);
  $("confirmReview").addEventListener("click", () => { if (!pendingAction || !canDecide) return; const note = $("reviewNote").value.trim(); if (!note) { window.alert("必须填写审核留言／备注"); return; } const { item, action } = pendingAction; item.status = action; item.reviewedAt = new Date().toISOString(); const communications = loadCommunications(); communications.push({ recordType: type, recordId: item.recordId, role: reviewerRole, account: session.account, name: `${reviewerRole}人员`, message: `${action === "approved" ? "批准" : "拒绝"}${item.kind}：${note}`, time: new Date().toISOString() }); saveCommunications(communications); try { const sourceKey = item.sourceKey || "prototypeVerificationReviewApplications", saved = JSON.parse(sessionStorage.getItem(sourceKey) || "[]"), target = saved.find((entry) => entry.id === item.id); if (target) { target.status = action; target.operatorNote = note; target.reviewedAt = item.reviewedAt; sessionStorage.setItem(sourceKey, JSON.stringify(saved)); } } catch (_) { /* local preview only */ } closeDialog(); render(); });
  document.documentElement.dataset.prototypeVersion = VERSION; render();
})();

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  if (!session || session.role !== "teacher") return;

  const hash = Array.from(String(session.cloudbaseUserId || session.account || "teacher")).reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);
  const teacherId = `T${String(hash % 900 + 100).padStart(3, "0")}`;
  const teacherName = session.staffName || "当前登录老师";
  const labels = { normal: "正常", review: "审核中", void: "已作废" };
  const customerNames = ["王女士", "陈先生", "林女士", "周先生", "张女士", "刘先生"];
  const projects = ["普拉提", "体态评估", "康复训练", "瑜伽", "力量训练", "产后恢复"];
  const baseVerifications = Array.from({ length: 9 }, (_, index) => ({ id: `VE-${teacherId}-${String(index + 1).padStart(4, "0")}`, teacherId, customer: customerNames[(hash + index) % customerNames.length], project: projects[(hash + index * 2) % projects.length], time: `2026-08-${String(1 + index).padStart(2, "0")} ${String(9 + index % 8).padStart(2, "0")}:20`, status: index === 2 ? "review" : index === 7 ? "void" : "normal", face: "人脸核验通过" }));
  const baseRecharges = Array.from({ length: 7 }, (_, index) => ({ id: `RC-${teacherId}-${String(index + 1).padStart(4, "0")}`, teacherId, customer: customerNames[(hash + index * 2) % customerNames.length], project: projects[(hash + index) % projects.length], count: 10 + index * 5, time: `2026-07-${String(18 + index).padStart(2, "0")} 14:30`, status: index === 4 ? "review" : index === 6 ? "void" : "normal" }));
  const read = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { return []; } };
  const write = (key, rows) => sessionStorage.setItem(key, JSON.stringify(rows));
  const ownRows = (key) => read(key).filter((row) => row.teacherId === teacherId);
  let activeType = "verification";
  let dialogMode = "verification";

  const verificationApplications = () => ownRows("prototypeTeacherVerificationApplications");
  const rechargeVoidApplications = () => ownRows("prototypeTeacherRechargeVoidApplications");
  const verificationRows = () => baseVerifications.map((row) => {
    const latest = verificationApplications().filter((item) => item.recordId === row.id && item.status === "pending").at(-1);
    return latest ? { ...row, status: "review" } : row;
  });
  const rechargeRows = () => baseRecharges.map((row) => {
    const latest = rechargeVoidApplications().filter((item) => item.recordId === row.id && item.status === "pending").at(-1);
    return latest ? { ...row, status: "review" } : row;
  });

  function renderSummary() {
    const verification = verificationRows(), recharge = rechargeRows();
    const reviewing = verification.filter((row) => row.status === "review").length + recharge.filter((row) => row.status === "review").length;
    $("teacherSummary").innerHTML = [["primary", teacherName, "", `老师编号：${teacherId}`], ["", "我的核销", verification.length, "仅本人绑定记录"], ["", "我的充值", recharge.length, "仅本人绑定记录"], ["", "审核中", reviewing, "等待运营处理"]].map(([kind, title, value, note]) => `<article class="panel teacher-summary-card ${kind}"><span>${title}</span><strong>${value === "" ? "老师工作台" : value}</strong><small>${note}</small></article>`).join("");
  }
  function currentRows() { return activeType === "verification" ? verificationRows() : rechargeRows(); }
  function filteredRows() {
    const status = $("teacherRecordStatus").value, range = $("teacherRecordRange").value;
    return currentRows().filter((row, index) => (status === "all" || row.status === status) && (range === "all" || (range === "recent" ? index < 4 : index >= 4)));
  }
  function renderRecords() {
    const verification = activeType === "verification";
    $("teacherRecordsHead").innerHTML = verification ? "<tr><th>核销编号</th><th>客户</th><th>项目</th><th>人脸核验</th><th>核销时间</th><th>状态</th><th>操作</th></tr>" : "<tr><th>充值编号</th><th>客户</th><th>项目</th><th>充值次数</th><th>提交时间</th><th>状态</th><th>操作</th></tr>";
    const rows = filteredRows();
    $("teacherOrdersBody").innerHTML = rows.length ? rows.map((row) => `<tr><td>${row.id}</td><td>${row.customer}</td><td>${row.project}</td>${verification ? `<td>${row.face}</td>` : `<td>${row.count} 次</td>`}<td>${row.time}</td><td><span class="teacher-order-status ${row.status}">${labels[row.status]}</span></td><td><a class="teacher-order-link" href="teacher-work-order-detail.html?type=${activeType}&recordId=${encodeURIComponent(row.id)}">查看</a></td></tr>`).join("") : `<tr><td colspan="7" class="teacher-empty">没有符合条件的本人记录</td></tr>`;
  }
  function renderApplications() {
    const renderList = (rows, target, count, empty) => { $(count).textContent = `${rows.length} 条`; $(target).innerHTML = rows.length ? rows.slice().reverse().map((row) => `<article><div><strong>${row.kind} · ${row.recordId}</strong><span>${row.reason}</span></div><b class="teacher-order-status ${row.status === "pending" ? "review" : row.status}">${row.status === "pending" ? "待运营审核" : labels[row.status] || row.status}</b></article>`).join("") : `<p class="teacher-empty">${empty}</p>`; };
    renderList(verificationApplications(), "verificationApplicationList", "verificationApplicationCount", "暂未提交核销审核申请");
    renderList(rechargeVoidApplications(), "rechargeApplicationList", "rechargeApplicationCount", "暂未提交充值作废审核申请");
  }
  function setActiveTab(type) { activeType = type; $("teacherVerificationTab").classList.toggle("active", type === "verification"); $("teacherRechargeTab").classList.toggle("active", type === "recharge"); $("teacherVerificationTab").setAttribute("aria-selected", String(type === "verification")); $("teacherRechargeTab").setAttribute("aria-selected", String(type === "recharge")); renderRecords(); }
  function openDialog(mode) {
    dialogMode = mode; const verification = mode === "verification", rows = verification ? verificationRows() : rechargeRows();
    $("teacherReviewTitle").textContent = verification ? "提交核销审核" : "申请作废充值审核";
    $("teacherReviewHint").textContent = verification ? "只能对本人绑定的核销记录提交补录或作废审核。" : "只能对本人绑定的充值记录提交作废审核。";
    $("teacherReviewKindField").hidden = !verification;
    $("teacherReviewRecord").innerHTML = `<option value="">请选择本人${verification ? "核销" : "充值"}记录</option>${rows.filter((row) => row.status === "normal").map((row) => `<option value="${row.id}">${row.id} · ${row.customer} · ${row.project}</option>`).join("")}`;
    $("teacherReviewReason").value = ""; $("teacherReviewMessage").textContent = ""; $("teacherReviewDialog").showModal();
  }
  function closeDialog() { $("teacherReviewDialog").close(); }
  function submitApplication(event) {
    event.preventDefault(); const recordId = $("teacherReviewRecord").value, reason = $("teacherReviewReason").value.trim();
    if (!recordId || !reason) { $("teacherReviewMessage").textContent = "请选择本人记录并填写申请原因。"; return; }
    const verification = dialogMode === "verification", key = verification ? "prototypeTeacherVerificationApplications" : "prototypeTeacherRechargeVoidApplications";
    const rows = read(key); if (rows.some((row) => row.teacherId === teacherId && row.recordId === recordId && row.status === "pending")) { $("teacherReviewMessage").textContent = "该记录已有待审核申请，不能重复提交。"; return; }
    rows.push({ id: `${verification ? "AP-V" : "AP-RV"}-${Date.now()}`, teacherId, teacherName, recordId, kind: verification ? $("teacherReviewKind").value : "作废充值", reason, status: "pending", submittedAt: new Date().toISOString() }); write(key, rows);
    closeDialog(); renderSummary(); renderRecords(); renderApplications();
  }
  $("teacherVerificationTab").addEventListener("click", () => setActiveTab("verification"));
  $("teacherRechargeTab").addEventListener("click", () => setActiveTab("recharge"));
  $("teacherRecordStatus").addEventListener("change", renderRecords); $("teacherRecordRange").addEventListener("change", renderRecords);
  $("clearTeacherFilters").addEventListener("click", () => { $("teacherRecordStatus").value = "all"; $("teacherRecordRange").value = "all"; renderRecords(); });
  $("openVerificationReview").addEventListener("click", () => openDialog("verification")); $("openRechargeVoid").addEventListener("click", () => openDialog("recharge"));
  $("closeTeacherReview").addEventListener("click", closeDialog); $("cancelTeacherReview").addEventListener("click", closeDialog); $("teacherReviewForm").addEventListener("submit", submitApplication);
  renderSummary(); renderRecords(); renderApplications();
})();

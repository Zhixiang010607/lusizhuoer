(() => {
  "use strict";
  const VERSION = "0.14.37", type = document.body.dataset.recordDetail, p = new URLSearchParams(location.search), $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const loadSessionRows = (key) => { try { const rows = JSON.parse(sessionStorage.getItem(key) || "[]"); return Array.isArray(rows) ? rows : []; } catch (_) { return []; } };
  const createdRecordId = p.get("recordId") || "";
  const createdRecord = p.get("source") === "created"
    ? loadSessionRows(type === "recharge" ? "prototypeRechargeRecords" : "prototypeVerificationRecords").find((row) => String(row?.id || "") === createdRecordId)
    : null;

  if (p.get("source") === "created") {
    let loginSession = null; try { loginSession = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { loginSession = null; }
    if (!createdRecord) {
      $("recordHero").innerHTML = `<div class="profile-avatar">!</div><div><span class="profile-type">工单读取失败</span><h2>未找到刚生成的工单</h2><p>请返回查询页面，从数据库中的记录重新进入。</p></div>`;
      $("recordInfo").innerHTML = `<article><span>工单编号</span><strong>${escapeHtml(createdRecordId || "—")}</strong></article>`;
      [$("versionBody")?.closest(".detail-section"), $("recordAudit")?.closest(".detail-section"), $("communicationLog")?.closest(".detail-section"), $("verificationVoidPanel")].filter(Boolean).forEach((section) => { section.hidden = true; });
      document.documentElement.dataset.prototypeVersion = VERSION;
      return;
    }

    const recordCode = String(createdRecord.recordCode || createdRecord.id);
    const statusCode = String(createdRecord.status || "PENDING").toUpperCase();
    const statusLabel = { PENDING: "待审核", APPROVED: "已通过", REJECTED: "已驳回" }[statusCode] || statusCode;
    const storeLabel = [createdRecord.storeName, createdRecord.storeId].filter(Boolean).join(" · ") || "—";
    const customerLabel = [createdRecord.customerName, createdRecord.customerId].filter(Boolean).join(" · ") || "—";
    const projectLabel = [createdRecord.projectName, createdRecord.projectCode].filter(Boolean).join(" · ") || "—";
    const teacherLabel = createdRecord.teacherName
      ? [createdRecord.teacherName, createdRecord.teacherCode].filter(Boolean).join(" · ")
      : "未指定";
    const createdAt = createdRecord.createdAt ? new Date(createdRecord.createdAt).toLocaleString("zh-CN", { hour12: false }) : "—";
    const typeLabel = type === "recharge" ? "充值单" : String(createdRecord.verificationType || "核销单");
    const cards = (items) => items.map(([key, value]) => `<article><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");

    $("recordHero").innerHTML = `<div class="profile-avatar">${type === "recharge" ? "充" : "核"}</div><div><span class="profile-type">${escapeHtml(typeLabel)}</span><h2>${escapeHtml(recordCode)}</h2><p>${escapeHtml(customerLabel)} · ${escapeHtml(projectLabel)} · ${escapeHtml(statusLabel)}</p></div>`;
    const info = type === "recharge"
      ? [["充值单编号", recordCode], ["申请类型", createdRecord.applicationType || "新充值"], ["门店", storeLabel], ["客户", customerLabel], ["项目", projectLabel], ["业务老师", teacherLabel], ["充值次数", `+${Number(createdRecord.count || 0)} 次`], ["提交时间", createdAt], ["审核状态", statusLabel]]
      : [["核销单编号", recordCode], ["核销类型", createdRecord.verificationType || "正常核销"], ["门店", storeLabel], ["客户", customerLabel], ["项目", projectLabel], ["业务老师", teacherLabel], ["核销次数", `${Number(createdRecord.count || 1)} 次`], ["提交时间", createdAt], ["审核状态", statusLabel], ["人脸识别", createdRecord.faceVerification || "—"]];
    $("recordInfo").innerHTML = cards(info);

    const versionSection = $("versionBody")?.closest(".detail-section");
    if (versionSection) versionSection.hidden = true;
    $("recordAudit").innerHTML = `<div><strong>${escapeHtml(createdAt)}</strong><span>${type === "recharge" ? "充值申请已创建并进入待审核" : statusCode === "PENDING" ? "补录核销已提交，等待审核" : "正常核销单已生成"}</span></div>`;
    if (type === "verification") {
      $("deviceEvidence").innerHTML = `<span>人脸识别</span><strong>${escapeHtml(createdRecord.faceVerification || "—")}</strong><span>设备信号</span><strong>${escapeHtml(createdRecord.deviceSignal || "—")}</strong>`;
      $("verificationVoidPanel").hidden = true;
    }

    const loadCommunications = () => loadSessionRows("prototypeCommunications");
    const renderCommunications = () => {
      const rows = loadCommunications().filter((row) => row.recordType === type && String(row.recordId) === String(createdRecord.id));
      $("communicationLog").innerHTML = rows.map((row) => `<article class="communication-item"><div><strong>${escapeHtml(row.role)} · ${escapeHtml(row.name)}</strong><time>${new Date(row.time).toLocaleString("zh-CN", { hour12: false })}</time></div><p>${escapeHtml(row.message)}</p></article>`).join("");
    };
    $("sendCommunication").addEventListener("click", () => {
      const message = $("communicationMessage").value.trim();
      if (!message) return;
      const rows = loadCommunications();
      const role = loginSession?.role === "store" ? "门店" : loginSession?.role === "operation" ? "运营" : "总部";
      rows.push({ recordType: type, recordId: createdRecord.id, role, account: loginSession?.account || "unknown", name: `${role}人员`, message, time: new Date().toISOString() });
      sessionStorage.setItem("prototypeCommunications", JSON.stringify(rows));
      $("communicationMessage").value = "";
      renderCommunications();
    });
    renderCommunications();
    document.documentElement.dataset.prototypeVersion = VERSION;
    return;
  }

  const id = p.get("recordId") || (type === "recharge" ? "RC-00001" : "VE-00001"), customer = p.get("customerId") || "C001001", store = p.get("storeId") || "S001", seed = Number(id.replace(/\D/g, "")) || 1, project = ["普拉提", "体态评估", "康复训练", "瑜伽", "力量训练", "产后恢复"][seed % 6];
  let loginSession = null; try { loginSession = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { loginSession = null; }
  const verificationKind = p.get("kind") || (id.includes("SUP") ? "补录" : "正常");
  const applicationType = type === "recharge" ? (p.get("kind") || "新充值") : verificationKind;
  const displayStatus = type === "verification" ? verificationKind : (applicationType === "作废充值" ? "作废" : "正常");
  const reviewProgress = displayStatus === "正常" ? "已完成" : "审核中";
  let customerOverrides = {};
  try { customerOverrides = JSON.parse(sessionStorage.getItem("prototypeCustomerOverrides") || "{}"); } catch (_) { customerOverrides = {}; }
  const customerName = customerOverrides[customer]?.name || p.get("customerName") || "客户1";
  const cards = (items) => items.map(([k, v]) => `<article><span>${k}</span><strong>${v}</strong></article>`).join("");
  const baseId = id.replace(/-V\d+$/, ""), viewedId = !/-V\d+$/.test(id) ? `${baseId}-V2` : id;
  $("recordHero").innerHTML = `<div class="profile-avatar">${type === "recharge" ? "充" : "核"}</div><div><span class="profile-type">记录编号</span><h2>${viewedId}</h2><p>${store} · ${project} · ${displayStatus}</p></div>`;
  const projectId = `P${String(seed % 6 + 1).padStart(3, "0")}`;
  const applicationId = `AP-${type === "recharge" ? "R" : "V"}-${String(seed % 10000).padStart(4, "0")}`;
  const canOpenAggregates = loginSession?.role === "hq";
  const storeValue = canOpenAggregates ? `<a class="record-link" href="store-detail.html?storeId=${encodeURIComponent(store)}">${store}</a>` : store;
  const projectValue = canOpenAggregates ? `<a class="record-link" href="project-detail.html?projectId=${projectId}">${project}（${projectId}）</a>` : `${project}（${projectId}）`;
  const info = [["申请编号", applicationId], ["申请类型", applicationType], ["记录编号", viewedId], ["客户编号", `<a class="record-link" href="customer-detail.html?customerId=${customer}&customerName=${encodeURIComponent(customerName)}&storeId=${store}">${customer}</a>`], ["客户姓名", customerName], ["门店", storeValue], ["项目", projectValue], ["提交时间", "2026-08-05 16:20:18"], ["发起账号/姓名", `${store}账号 · 门店人员`], ["状态", displayStatus], ["审核进度", reviewProgress], ["审核操作", reviewProgress === "审核中" ? "等待运营审核" : "已完成审核"], ["批准/驳回时间", reviewProgress === "审核中" ? "待批准" : "2026-08-05 17:02:41"]];
  if (type === "recharge") info.push(["充值次数", `+${10 + seed % 20}次`], ["次数影响", `+${10 + seed % 20}次`], ["办卡照片", "已拍摄"], ["扫脸结果", "活体与面容匹配通过"], ["设备信号", "不涉及"]);
  if (type === "verification") { const teacherId = `T${String(seed % 12 + 1).padStart(3, "0")}`, teacherValue = canOpenAggregates ? `<a class="record-link" href="teacher-detail.html?teacherId=${teacherId}">业务老师 ${String(seed % 12 + 1).padStart(2, "0")}（${teacherId}）</a>` : `业务老师 ${String(seed % 12 + 1).padStart(2, "0")}（${teacherId}）`; info.push(["业务老师", teacherValue], ["核销次数", "1次"], ["次数影响", verificationKind === "作废" ? "核销 -1 / 余额 +1" : "核销 +1"], ["人脸识别", "活体检测与人脸比对通过"], ["设备信号", verificationKind === "补录" ? "不发送（补录）" : verificationKind === "作废" ? "不重复发送" : "虚拟端口已发送"]); }
  $("recordInfo").innerHTML = cards(info);
  const versionPage = type === "recharge" ? "recharge-detail.html" : "verification-detail.html";
  const versionUrl = (versionId) => `${versionPage}?recordId=${encodeURIComponent(versionId)}&customerId=${encodeURIComponent(customer)}&customerName=${encodeURIComponent(customerName)}&storeId=${encodeURIComponent(store)}`;
  const versionRow = (versionId, version, status, operator, relation) => {
    const evidence = type === "verification" ? " · 人脸识别已通过" : "";
    return `<tr class="${viewedId === versionId ? "selected-version" : ""}"><td><a class="record-link" href="${versionUrl(versionId)}">${versionId}</a>${viewedId === versionId ? '<span class="current-view-badge">正在查看</span>' : ""}</td><td>${version}</td><td>门店：${store} · ${project}${evidence}</td><td>${status}</td><td>${operator}</td><td>${relation}</td></tr>`;
  };
  $("versionBody").innerHTML = versionRow(`${baseId}-V1`, "V1", "历史版本", `${store}账号 · 门店人员`, type === "verification" ? "原始记录及人脸识别结果" : "原始记录") + versionRow(`${baseId}-V2`, "V2", "当前有效", "OP001 · 运营管理员", type === "verification" ? "关联V1、原始记录及人脸识别结果" : "关联V1及原始记录");
  const ownerView = ["store", "teacher"].includes(loginSession?.role);
  if (ownerView) {
    document.querySelector("#recordAudit")?.closest(".detail-section")?.querySelector("h2") && (document.querySelector("#recordAudit").closest(".detail-section").querySelector("h2").textContent = "审核结果与留言");
    $("recordAudit").innerHTML = `<div><strong>审核结果</strong><span>${reviewProgress === "审核中" ? "待审核" : "已通过"}</span></div><div><strong>留言区</strong><span></span></div>`;
    const communicationHeading = $("communicationLog")?.closest(".communication-panel")?.querySelector("h2");
    if (communicationHeading) communicationHeading.textContent = "留言区";
  } else $("recordAudit").innerHTML = `<div><strong>2026-08-05 16:20:18</strong><span>${store}账号 · 门店人员提交单据并创建记录</span></div><div><strong>2026-08-05 17:02:41</strong><span>OP001 · 运营管理员审核并生成当前版本</span></div>`;
  if (type === "verification") $("deviceEvidence").innerHTML = verificationKind === "补录" ? `<span>虚拟端口</span><strong>不调用</strong><span>原因</span><strong>补录核销不打开设备</strong>` : `<span>虚拟端口</span><strong>PORT-${store}-P${String(seed % 6 + 1).padStart(3, "0")}</strong><span>机器响应</span><strong class="success-text">权限已打开</strong>`;
  const loadCommunications = () => { try { return JSON.parse(sessionStorage.getItem("prototypeCommunications") || "[]"); } catch (_) { return []; } };
  const saveCommunications = (rows) => { try { sessionStorage.setItem("prototypeCommunications", JSON.stringify(rows)); } catch (_) { /* 静态演示 */ } };
  function renderCommunications() {
    const rows = loadCommunications().filter((row) => row.recordType === type && row.recordId === id);
    $("communicationLog").innerHTML = rows.map((row) => `<article class="communication-item"><div><strong>${escapeHtml(row.role)} · ${escapeHtml(row.name)}</strong><time>${new Date(row.time).toLocaleString("zh-CN", { hour12: false })}</time></div><p>${escapeHtml(row.message)}</p></article>`).join("");
    $("communicationLog").scrollTop = $("communicationLog").scrollHeight;
  }
  $("sendCommunication").addEventListener("click", () => { const message = $("communicationMessage").value.trim(); if (!message) return; const rows = loadCommunications(), role = loginSession?.role === "store" ? "门店" : loginSession?.role === "operation" ? "运营" : "总部"; rows.push({ recordType: type, recordId: id, role, account: loginSession?.account || "unknown", name: `${role}人员`, message, time: new Date().toISOString() }); saveCommunications(rows); $("communicationMessage").value = ""; renderCommunications(); });
  if (type === "verification") {
    if (loginSession?.role !== "store" || verificationKind === "作废") $("verificationVoidPanel").hidden = true;
    else $("submitVoidApplication").addEventListener("click", () => { const note = $("voidApplicationNote").value.trim(); if (!note) { $("voidApplicationMessage").textContent = "作废申请必须填写备注"; return; } let apps = []; try { apps = JSON.parse(sessionStorage.getItem("prototypeVerificationReviewApplications") || "[]"); } catch (_) { apps = []; } if (apps.some((app) => app.kind === "作废" && app.recordId === id && app.status === "pending")) { $("voidApplicationMessage").textContent = "该核销已有待审核作废申请"; return; } apps.push({ id: `AP-V-${Date.now()}`, kind: "作废", recordId: id, storeId: store, customerId: customer, customerName, projectId, project, teacherId: `T${String(seed % 12 + 1).padStart(3, "0")}`, applicantNote: note, status: "pending", time: new Date().toISOString(), photo: "沿用原核销照片", deviceSignal: "不重复发送" }); sessionStorage.setItem("prototypeVerificationReviewApplications", JSON.stringify(apps)); const messages = loadCommunications(); messages.push({ recordType: type, recordId: id, role: "门店", account: loginSession.account, name: "门店人员", message: `申请作废：${note}`, time: new Date().toISOString() }); saveCommunications(messages); $("voidApplicationMessage").textContent = "作废申请已提交运营审核；审核完成前仍计入核销"; $("submitVoidApplication").disabled = true; renderCommunications(); });
  }
  renderCommunications();
  document.documentElement.dataset.prototypeVersion = VERSION;
})();

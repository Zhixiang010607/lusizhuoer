(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const role = params.get("role");
  const personId = params.get("id");
  const labels = { teacher: "老师", operation: "运营", hq: "总部人员" };
  const pages = { teacher: "teacher-management.html", operation: "operation-account-management.html", hq: "hq-management.html" };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const truthy = (value) => [true, "true", "t", 1, "1"].includes(value);
  let staff = null;
  const experience = { rows: [], history: [], activeProducts: [], loading: false, rechargeRequestId: "" };

  function formatTime(value) {
    if (!value) return "未记录";
    return window.AppDateTime?.formatDate?.(value, "未记录") || String(value);
  }

  function numberValue(row, names, fallback = 0) {
    for (const name of names) {
      const value = Number(row?.[name]);
      if (Number.isFinite(value)) return value;
    }
    return fallback;
  }

  function stringValue(row, names, fallback = "") {
    for (const name of names) {
      const value = String(row?.[name] ?? "").trim();
      if (value) return value;
    }
    return fallback;
  }

  function credentialStatus() {
    return truthy(staff.password_change_required) ? "临时密码待本人修改" : "密码已由本人确认";
  }

  function isStaffArchived() {
    return [staff?.account_status, staff?.teacher_status, staff?.status]
      .some((value) => String(value || "").toUpperCase() === "ARCHIVED");
  }

  function teacherId() {
    return stringValue(staff, ["teacher_id", "teacherId"]);
  }

  function setExperienceMessage(id, message = "", tone = "") {
    const target = $(id);
    if (!target) return;
    target.textContent = message;
    target.dataset.tone = tone;
  }

  function normalizeExperienceRow(row = {}) {
    return {
      id: stringValue(row, ["id", "entitlementId", "entitlement_id"]),
      productId: stringValue(row, ["productId", "product_id"]),
      productCode: stringValue(row, ["productCode", "product_code"]),
      productName: stringValue(row, ["productName", "product_name"], "未命名产品"),
      productStatus: stringValue(row, ["productStatus", "product_status"], "ACTIVE").toUpperCase(),
      monthlyAllowance: numberValue(row, ["monthlyAllowance", "monthly_allowance"]),
      usedCount: numberValue(row, ["usedCount", "used_count"]),
      manualRechargeCount: numberValue(row, ["manualRechargeCount", "manual_recharge_count"]),
      availableCount: numberValue(row, ["availableCount", "available_count"]),
      quotaMonth: stringValue(row, ["quotaMonth", "quota_month"]),
      monthlyResetAt: stringValue(row, ["monthlyResetAt", "monthly_reset_at"])
    };
  }

  function rowProductLabel(row) {
    return `${row.productName}${row.productCode ? `（${row.productCode}）` : ""}`;
  }

  function normalizeExperienceHistory(row = {}) {
    return {
      at: stringValue(row, ["createdAt", "created_at", "occurredAt", "occurred_at", "eventAt", "event_at"]),
      type: stringValue(row, ["eventType", "event_type", "type", "recordType", "record_type"], "体验额度变更"),
      productName: stringValue(row, ["productName", "product_name"], "未命名产品"),
      productCode: stringValue(row, ["productCode", "product_code"]),
      count: numberValue(row, ["unitCount", "unit_count", "deltaCount", "delta_count", "count", "amount"]),
      note: stringValue(row, ["note", "message", "reason"]),
      actorName: stringValue(row, ["actorName", "actor_name", "createdByName", "created_by_name", "operatorName", "operator_name"], "系统／总部")
    };
  }

  function renderExperienceProductSelect() {
    const select = $("teacherExperienceProduct");
    if (!select) return;
    const configured = new Set(experience.rows.map((row) => row.productId).filter(Boolean));
    const eligible = experience.activeProducts.filter((product) => !configured.has(product.id));
    const disabled = experience.loading || isStaffArchived() || !eligible.length;
    select.innerHTML = eligible.length
      ? `<option value="">请选择尚未配置的活跃产品</option>${eligible.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}${product.code ? `（${escapeHtml(product.code)}）` : ""}</option>`).join("")}`
      : `<option value="">${isStaffArchived() ? "老师已封存，不能新增配置" : "没有可新增的活跃产品"}</option>`;
    select.disabled = disabled;
    $("teacherExperienceMonthlyCount").disabled = disabled;
    $("saveTeacherExperienceConfig").disabled = disabled;
  }

  function syncExperienceRechargeControls() {
    const disabled = experience.loading || isStaffArchived();
    ["teacherExperienceRechargeCount", "teacherExperienceRechargeNote", "saveTeacherExperienceRecharge"]
      .map($)
      .filter(Boolean)
      .forEach((element) => { element.disabled = disabled; });
    if (disabled && $("teacherExperienceRechargePanel")) $("teacherExperienceRechargePanel").hidden = true;
  }

  function renderExperienceRows() {
    const target = $("teacherExperienceRows");
    if (!target) return;
    if (!experience.rows.length) {
      target.innerHTML = '<tr><td colspan="7" class="teacher-experience-empty">尚未配置任何产品体验次数。</td></tr>';
      return;
    }
    target.innerHTML = experience.rows.map((row) => {
      const archived = row.productStatus === "ARCHIVED";
      const action = archived || isStaffArchived()
        ? `<span class="teacher-experience-status archived">${archived ? "产品已封存" : "老师已封存"}</span>`
        : `<button type="button" class="secondary-button teacher-experience-recharge-button" data-experience-product-id="${escapeHtml(row.productId)}">单独充值</button>`;
      return `<tr><td><strong>${escapeHtml(row.productName)}</strong>${row.productCode ? `<small>${escapeHtml(row.productCode)}</small>` : ""}</td><td>${row.monthlyAllowance} 次</td><td>${row.usedCount} 次</td><td>${row.manualRechargeCount} 次</td><td><strong>${row.availableCount} 次</strong></td><td>${escapeHtml(formatTime(row.monthlyResetAt))}</td><td>${action}</td></tr>`;
    }).join("");
    target.querySelectorAll("[data-experience-product-id]").forEach((button) => {
      button.addEventListener("click", () => openRecharge(button.dataset.experienceProductId));
    });
  }

  function renderExperienceHistory() {
    const target = $("teacherExperienceHistoryRows");
    target.innerHTML = experience.history.length
      ? experience.history.map((row) => `<tr><td>${escapeHtml(formatTime(row.at))}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.productName)}${row.productCode ? ` · ${escapeHtml(row.productCode)}` : ""}</td><td>${row.count > 0 ? "+" : ""}${row.count} 次</td><td>${escapeHtml(row.note || "—")}</td><td>${escapeHtml(row.actorName)}</td></tr>`).join("")
      : '<tr><td colspan="6" class="teacher-experience-empty">暂无体验额度变更记录。</td></tr>';
  }

  function renderExperienceOverview(data = {}) {
    const total = numberValue(data, ["totalAvailableCount", "totalAvailable"], experience.rows.reduce((sum, row) => sum + row.availableCount, 0));
    const activeConfigured = experience.rows.filter((row) => row.productStatus === "ACTIVE").length;
    $("teacherExperienceState").textContent = isStaffArchived() ? "老师已封存 · 仅可查询" : `${activeConfigured} 个活跃产品`;
    $("teacherExperienceOverview").innerHTML = [
      ["可用体验次数", `${total} 次`],
      ["已配置产品", `${experience.rows.length} 个`],
      ["月初自动更新", "每月 1 日"],
      ["体验核销", "不扣客户余额"]
    ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");
  }

  function renderExperience(data = {}) {
    renderExperienceOverview(data);
    renderExperienceRows();
    renderExperienceHistory();
    renderExperienceProductSelect();
    syncExperienceRechargeControls();
  }

  async function loadTeacherExperience({ preserveMessage = false } = {}) {
    if (role !== "teacher" || !staff) return;
    $("teacherExperiencePanel").hidden = false;
    const id = teacherId();
    if (!id) {
      $("teacherExperienceState").textContent = "资料不完整";
      setExperienceMessage("teacherExperienceConfigMessage", "老师资料缺少数据库编号，无法读取体验额度。", "error");
      return;
    }
    if (!window.CloudBasePhoneAuth?.getTeacherExperienceEntitlements) {
      $("teacherExperienceState").textContent = "服务未部署";
      setExperienceMessage("teacherExperienceConfigMessage", "体验额度服务尚未加载，请部署最新后台后重试。", "error");
      return;
    }
    experience.loading = true;
    $("teacherExperienceState").textContent = "正在读取";
    renderExperienceProductSelect();
    syncExperienceRechargeControls();
    try {
      const [data, products] = await Promise.all([
        window.CloudBasePhoneAuth.getTeacherExperienceEntitlements({ teacherId: id }),
        window.CloudBasePhoneAuth.listProducts()
      ]);
      experience.rows = (Array.isArray(data?.entitlements) ? data.entitlements : []).map(normalizeExperienceRow).filter((row) => row.productId);
      const history = [data?.history, data?.ledger, data?.events, data?.records].find(Array.isArray) || [];
      experience.history = history.map(normalizeExperienceHistory);
      experience.activeProducts = (Array.isArray(products) ? products : []).map((product) => ({
        id: stringValue(product, ["id", "product_id"]),
        code: stringValue(product, ["product_code", "productCode"]),
        name: stringValue(product, ["product_name", "productName"]),
        status: stringValue(product, ["product_status", "productStatus"], "ACTIVE").toUpperCase()
      })).filter((product) => product.id && product.name && product.status === "ACTIVE");
      renderExperience(data);
      if (isStaffArchived()) setExperienceMessage("teacherExperienceConfigMessage", "老师已封存，体验额度与历史仍可查询，但不能新增配置或充值。", "");
      else if (!preserveMessage) setExperienceMessage("teacherExperienceConfigMessage", "");
    } catch (error) {
      $("teacherExperienceState").textContent = "读取失败";
      $("teacherExperienceRows").innerHTML = `<tr><td colspan="7" class="teacher-experience-empty error-text">${escapeHtml(error?.message || "体验额度读取失败")}</td></tr>`;
      setExperienceMessage("teacherExperienceConfigMessage", error?.message || "体验额度读取失败，请稍后重试。", "error");
    } finally {
      experience.loading = false;
      renderExperienceProductSelect();
      syncExperienceRechargeControls();
    }
  }

  function requestId(prefix) {
    const token = window.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${token}`.slice(0, 64);
  }

  function openRecharge(productId) {
    const row = experience.rows.find((item) => item.productId === String(productId));
    if (!row || row.productStatus === "ARCHIVED" || isStaffArchived()) return;
    $("teacherExperienceRechargeProductId").value = row.productId;
    $("teacherExperienceRechargeTarget").textContent = `正在为 ${rowProductLabel(row)} 单独充值体验次数；这不会影响任何客户的购买或剩余次数。`;
    $("teacherExperienceRechargeCount").value = "";
    $("teacherExperienceRechargeNote").value = "";
    experience.rechargeRequestId = "";
    setExperienceMessage("teacherExperienceRechargeMessage", "");
    $("teacherExperienceRechargePanel").hidden = false;
    $("teacherExperienceRechargeCount").focus({ preventScroll: true });
  }

  function closeRecharge() {
    $("teacherExperienceRechargePanel").hidden = true;
    $("teacherExperienceRechargeProductId").value = "";
    experience.rechargeRequestId = "";
    setExperienceMessage("teacherExperienceRechargeMessage", "");
  }

  function renderError(message) {
    $("staffDetailContent").innerHTML = `<article class="panel info-card"><span>人员详情</span><strong>${escapeHtml(message)}</strong></article>`;
    $("staffStatusHint").textContent = "未读取到可操作的账号。";
  }

  function render() {
    const status = isStaffArchived() ? "封存" : "活跃";
    $("staffDetailTitle").textContent = `${labels[role]}全局视图`;
    $("backToManagement").href = pages[role];
    const cards = [
      ["唯一身份 ID", staff.auth_uid], ["业务编号", staff.person_code], ["姓名", staff.staff_name],
      ["联系电话", staff.phone || "未填写"], ["身份", labels[role]], ["状态", status],
      ["密码状态", credentialStatus()], ["初始密码设置", formatTime(staff.password_initialized_at)],
      ["最后密码变更", formatTime(staff.password_changed_at)]
    ];
    if (role === "teacher") {
      const enrollment = String(staff.face_enrollment_status || staff.faceEnrollmentStatus || "").toUpperCase();
      cards.splice(6, 0, ["人脸绑定", enrollment === "ENROLLED" ? "已绑定" : "未完成"]);
    }
    $("staffDetailContent").innerHTML = cards.map(([label, value]) => `<article class="panel info-card"><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    const scopePanel = document.querySelector(".staff-global-panel");
    if (role === "hq") scopePanel?.remove();
    else {
      $("staffScopeHint").textContent = role === "teacher" ? "仅显示该老师本人绑定的核销、充值与审核记录。" : "仅显示该运营账号被授权范围内的数据。";
      $("staffScopeContent").textContent = "暂无该账号范围内的业务数据";
    }
    const statusAction = $("staffStatusAction");
    statusAction.hidden = false;
    statusAction.textContent = status === "活跃" ? `封存${labels[role]}` : `激活${labels[role]}`;
    statusAction.classList.toggle("danger-button", status === "活跃");
    $("staffStatusHint").textContent = status === "活跃"
      ? "封存后该人员无法登录，历史业务记录和体验额度记录都会保留。"
      : "激活后该人员可再次登录；历史业务记录保持不变。";
    const credentialAction = $("staffCredentialAction");
    credentialAction.hidden = false;
    credentialAction.textContent = "重置临时密码";
  }

  async function load() {
    if (!labels[role] || !personId) return renderError("缺少人员身份或编号。");
    try {
      const records = await window.CloudBasePhoneAuth.listStaff(role);
      staff = records.find((item) => [item.auth_uid, item.id, item.staff_id, item.teacher_id]
        .map((value) => String(value || "").trim())
        .includes(personId));
      if (!staff) return renderError("未找到该人员，可能已被删除或无权查看。");
      render();
      if (role === "teacher") await loadTeacherExperience();
    } catch (error) {
      renderError(error?.message || "人员资料读取失败。");
    }
  }

  $("staffCredentialAction").addEventListener("click", async () => {
    if (!staff?.auth_uid) return;
    const newPassword = window.prompt("输入新的临时密码（8–32 位，至少包含大写、小写、数字、特殊字符中的三类）：");
    if (newPassword === null) return;
    const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(newPassword)).length;
    if (newPassword.length < 8 || newPassword.length > 32 || groups < 3) return window.alert("密码格式不符合要求。");
    if (!window.confirm(`确认重置“${staff.staff_name}”的密码？旧密码不会显示或保留。`)) return;
    const button = $("staffCredentialAction");
    button.disabled = true;
    try {
      await window.CloudBasePhoneAuth.resetStaffPassword({ uid: staff.auth_uid, newPassword });
      staff.password_change_required = true;
      staff.password_changed_at = new Date().toISOString();
      render();
      window.alert("已重置临时密码。请通过安全渠道单独告知本人。该人员下次应立即修改密码。");
    } catch (error) {
      window.alert(error?.message || "密码重置失败，请稍后重试。");
    } finally { button.disabled = false; }
  });

  $("staffStatusAction").addEventListener("click", async () => {
    if (!staff) return;
    const archived = isStaffArchived();
    const next = archived ? "ACTIVE" : "ARCHIVED";
    const text = archived ? "激活" : "封存";
    if (!window.confirm(`确认${text}${labels[role]}“${staff.staff_name}”？`)) return;
    const button = $("staffStatusAction");
    button.disabled = true;
    try {
      const masterId = role === "teacher" ? teacherId() : "";
      if (masterId && window.CloudBasePhoneAuth?.setMasterStatus) {
        await window.CloudBasePhoneAuth.setMasterStatus({ teacherId: masterId, status: next });
      } else {
        await window.CloudBasePhoneAuth.setStaffStatus({ uid: staff.auth_uid, phone: staff.phone, status: next });
      }
      staff.account_status = next;
      staff.teacher_status = next;
      staff.status = next;
      render();
      if (role === "teacher") {
        closeRecharge();
        await loadTeacherExperience({ preserveMessage: true });
      }
    } catch (error) {
      window.alert(error?.message || `${text}失败，请稍后重试。`);
    } finally { button.disabled = false; }
  });

  $("teacherExperienceConfigForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!staff || isStaffArchived()) return;
    const productId = $("teacherExperienceProduct").value;
    const monthlyAllowance = Number($("teacherExperienceMonthlyCount").value);
    if (!productId || !Number.isInteger(monthlyAllowance) || monthlyAllowance < 0 || monthlyAllowance > 99999) {
      return setExperienceMessage("teacherExperienceConfigMessage", "请选择产品，并填写 0 至 99,999 的整数体验次数。", "error");
    }
    const button = $("saveTeacherExperienceConfig");
    button.disabled = true;
    setExperienceMessage("teacherExperienceConfigMessage", "正在保存体验额度配置…");
    try {
      await window.CloudBasePhoneAuth.upsertTeacherExperienceEntitlement({ teacherId: teacherId(), productId, monthlyAllowance });
      $("teacherExperienceMonthlyCount").value = "";
      setExperienceMessage("teacherExperienceConfigMessage", "体验额度配置已保存；该产品每月 1 日会按此次数自动更新。", "success");
      await loadTeacherExperience({ preserveMessage: true });
    } catch (error) {
      setExperienceMessage("teacherExperienceConfigMessage", error?.message || "体验额度配置保存失败。", "error");
    } finally { button.disabled = false; }
  });

  $("teacherExperienceRechargeForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!staff || isStaffArchived()) return;
    const productId = $("teacherExperienceRechargeProductId").value;
    const unitCount = Number($("teacherExperienceRechargeCount").value);
    const note = $("teacherExperienceRechargeNote").value.trim();
    if (!productId || !Number.isInteger(unitCount) || unitCount < 1 || unitCount > 99999) {
      return setExperienceMessage("teacherExperienceRechargeMessage", "请填写 1 至 99,999 的整数充值次数。", "error");
    }
    const button = $("saveTeacherExperienceRecharge");
    button.disabled = true;
    setExperienceMessage("teacherExperienceRechargeMessage", "正在为老师充值体验次数…");
    try {
      await window.CloudBasePhoneAuth.rechargeTeacherExperienceEntitlement({
        teacherId: teacherId(), productId, unitCount, note,
        clientRequestId: experience.rechargeRequestId || (experience.rechargeRequestId = requestId("teacher_experience_recharge"))
      });
      closeRecharge();
      setExperienceMessage("teacherExperienceConfigMessage", "老师体验次数已单独充值；客户余额未发生变化。", "success");
      await loadTeacherExperience({ preserveMessage: true });
    } catch (error) {
      setExperienceMessage("teacherExperienceRechargeMessage", error?.message || "体验次数充值失败。", "error");
    } finally { button.disabled = false; }
  });

  $("cancelTeacherExperienceRecharge")?.addEventListener("click", closeRecharge);
  ["teacherExperienceRechargeCount", "teacherExperienceRechargeNote"].forEach((id) => {
    $(id)?.addEventListener("input", () => { experience.rechargeRequestId = ""; });
  });
  void load();
})();

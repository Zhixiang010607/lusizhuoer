(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const role = params.get("role");
  // Accept the current staff-detail deep link as well as the former
  // teacher-detail links.  A teacher code is useful here because older query
  // and detail pages used it rather than the internal numeric master id.
  const personId = params.get("id") || params.get("teacherId") || params.get("teacherCode");
  const labels = { teacher: "老师", hq: "总部人员" };
  const pages = { teacher: "teacher-management.html", hq: "hq-management.html" };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const truthy = (value) => [true, "true", "t", 1, "1"].includes(value);
  let staff = null;
  let hasHonoredExperienceHash = false;
  const experience = { rows: [], totals: [], history: [], activeProducts: [], loading: false, savingConfig: false, savingRecharge: false, rechargeRequestId: "", historyExpanded: false, deletingProductId: "", productCatalogError: "" };

  function setButtonPending(button, pending, pendingLabel = "处理中…") {
    if (!button) return;
    if (pending) {
      button.dataset.pendingIdleLabel ||= button.textContent;
      button.dataset.pendingLabel = pendingLabel;
      button.textContent = pendingLabel;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      return;
    }
    if (button.textContent === button.dataset.pendingLabel) {
      button.textContent = button.dataset.pendingIdleLabel || button.textContent;
    }
    button.removeAttribute("aria-busy");
    delete button.dataset.pendingIdleLabel;
    delete button.dataset.pendingLabel;
  }

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

  function optionalNumberValue(row, names) {
    for (const name of names) {
      const raw = row?.[name];
      if (raw === null || raw === undefined || raw === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return null;
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
    const normalized = (value) => String(value || "").toUpperCase();
    const authoritative = [staff?.account_status, staff?.teacher_status]
      .map(normalized)
      .filter((value) => ["ACTIVE", "ARCHIVED"].includes(value));
    if (authoritative.length) return authoritative.includes("ARCHIVED");
    return [staff?.status, staff?.profile_status].map(normalized).includes("ARCHIVED");
  }

  function setStaffStatusFeedback(message, tone = "") {
    const target = $("staffStatusHint");
    if (!target) return;
    target.textContent = message;
    target.dataset.tone = tone;
  }

  function actionableStaffStatusError(error, action, refreshed, actualArchived) {
    const signature = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
    if (signature.includes("AUTH_CREDENTIAL_MISSING") || signature.includes("AUTH_ACCOUNT_MISSING")) {
      return "该记录没有可恢复的 CloudBase 登录凭据，属于压力测试或历史占位账号，只保留查询数据。激活未生效，账号已安全保持封存；如需登录，请通过“新增老师”创建正式账号。";
    }
    if (signature.includes("TEACHER_PROFILE_MISSING")) {
      return `老师主档同步尚未完成，${action}未生效。本页已重新读取当前状态；请先执行最新的老师资料修复迁移，再刷新后重试。`;
    }
    if (!refreshed) return `${action}结果暂时无法确认，且重新读取状态失败。请刷新页面确认后再操作，避免重复提交。`;
    return `${action}未确认生效。重新读取数据库后当前仍为“${actualArchived ? "封存" : "活跃"}”；请刷新后重试，如持续失败请检查老师主档与账号绑定。`;
  }

  function staffDisplayName() {
    return stringValue(staff, ["staff_name", "teacher_name"], labels[role] || "该人员");
  }

  function hasPhoneAuthMethod(method) {
    return typeof window.CloudBasePhoneAuth?.[method] === "function";
  }

  // Configuration, recharge and deletion are business actions.  The controls
  // are normally disabled for an archived teacher, but this guard also covers
  // stale pages and an archive that happens while the detail view is open.
  function canManageTeacherExperience(method, messageId, actionName) {
    if (!staff || !teacherId()) {
      setExperienceMessage(messageId, "老师资料缺少可用编号，无法办理体验额度操作。", "error");
      return false;
    }
    if (isStaffArchived()) {
      setExperienceMessage(messageId, "老师已封存，体验额度和历史仍可查询，但不能配置、删除或充值。", "error");
      return false;
    }
    if (!hasPhoneAuthMethod(method)) {
      setExperienceMessage(messageId, `${actionName}服务尚未加载，请部署最新后台后刷新本页。`, "error");
      return false;
    }
    return true;
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
      monthlyExperienceCount: numberValue(row, ["monthlyExperienceCount", "monthly_experience_count", "usedCount", "used_count"]),
      monthlyRechargeCount: numberValue(row, ["monthlyRechargeCount", "monthly_recharge_count"]),
      manualRechargeCount: numberValue(row, ["manualRechargeCount", "manual_recharge_count"]),
      availableCount: numberValue(row, ["availableCount", "available_count"]),
      totalExperienceCount: optionalNumberValue(row, ["totalExperienceCount", "total_experience_count", "totalUsedCount", "total_used_count", "lifetimeUsedCount", "lifetime_used_count"]),
      quotaMonth: stringValue(row, ["quotaMonth", "quota_month"]),
      monthlyResetAt: stringValue(row, ["monthlyResetAt", "monthly_reset_at"])
    };
  }

  function normalizeExperienceTotal(row = {}) {
    return {
      productId: stringValue(row, ["productId", "product_id"]),
      productCode: stringValue(row, ["productCode", "product_code"]),
      productName: stringValue(row, ["productName", "product_name"], "未命名产品"),
      productStatus: stringValue(row, ["productStatus", "product_status"], "ARCHIVED").toUpperCase(),
      totalExperienceCount: numberValue(row, ["totalExperienceCount", "total_experience_count", "totalUsedCount", "total_used_count"])
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
    const disabled = experience.loading || experience.savingConfig || isStaffArchived() || !eligible.length;
    const unavailableMessage = experience.productCatalogError
      ? "活跃产品目录暂不可用"
      : isStaffArchived()
        ? "老师已封存，不能新增配置"
        : "没有可新增的活跃产品";
    select.innerHTML = eligible.length
      ? `<option value="">请选择尚未配置的活跃产品</option>${eligible.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}${product.code ? `（${escapeHtml(product.code)}）` : ""}</option>`).join("")}`
      : `<option value="">${unavailableMessage}</option>`;
    select.disabled = disabled;
    $("teacherExperienceMonthlyCount").disabled = disabled;
    $("saveTeacherExperienceConfig").disabled = disabled;
  }

  function activeRechargeRows() {
    return experience.rows.filter((row) => row.productStatus === "ACTIVE");
  }

  function setRechargeTarget(row = null) {
    const target = $("teacherExperienceRechargeTarget");
    if (!target) return;
    if (isStaffArchived()) {
      target.textContent = "老师已封存，体验额度与充值历史仍可查询，但不能再充值。";
      return;
    }
    if (!row) {
      target.textContent = activeRechargeRows().length
        ? "选择已配置的活跃产品和次数后，额度立即增加；不会影响客户购买或剩余次数。"
        : "请先配置至少一个活跃产品，才能为老师单独充值。";
      return;
    }
    target.textContent = `正在为 ${rowProductLabel(row)} 单独充值；提交后会立即增加该产品的体验次数，不会影响客户余额。`;
  }

  function renderExperienceRechargeProductSelect() {
    const select = $("teacherExperienceRechargeProduct");
    if (!select) return;
    const rows = activeRechargeRows();
    const previous = select.value;
    const disabled = experience.loading || experience.savingRecharge || isStaffArchived() || !rows.length;
    select.innerHTML = rows.length
      ? `<option value="">请选择已配置的活跃产品</option>${rows.map((row) => `<option value="${escapeHtml(row.productId)}">${escapeHtml(rowProductLabel(row))}</option>`).join("")}`
      : `<option value="">${isStaffArchived() ? "老师已封存，不能充值" : "尚无可充值的活跃产品"}</option>`;
    select.value = rows.some((row) => row.productId === previous) ? previous : "";
    select.disabled = disabled;
    setRechargeTarget(rows.find((row) => row.productId === select.value) || null);
  }

  function syncExperienceRechargeControls() {
    const disabled = experience.loading || experience.savingRecharge || isStaffArchived() || !activeRechargeRows().length;
    ["teacherExperienceRechargeProduct", "teacherExperienceRechargeCount", "teacherExperienceRechargeNote", "saveTeacherExperienceRecharge"]
      .map($)
      .filter(Boolean)
      .forEach((element) => { element.disabled = disabled; });
  }

  function renderExperienceRows() {
    const target = $("teacherExperienceRows");
    if (!target) return;
    if (!experience.rows.length) {
      target.innerHTML = '<div class="teacher-experience-empty"><strong>尚未配置体验产品</strong><span>从右侧选择一个活跃产品，保存后会立即设为该产品当前可用的体验次数。</span></div>';
      return;
    }
    target.innerHTML = experience.rows.map((row) => {
      const archived = row.productStatus === "ARCHIVED";
      const unavailable = archived || isStaffArchived();
      const action = unavailable
        ? `<span class="teacher-experience-status archived">${archived ? "产品已封存" : "老师已封存"}</span>`
        : `<div class="teacher-experience-card-actions">
            <button type="button" class="teacher-experience-recharge-button" data-experience-product-id="${escapeHtml(row.productId)}" aria-label="为${escapeHtml(row.productName)}充值体验次数">充值</button>
            <button type="button" class="teacher-experience-delete-button" data-experience-delete-product-id="${escapeHtml(row.productId)}" aria-label="删除${escapeHtml(row.productName)}的体验额度配置"${experience.deletingProductId === row.productId ? ' disabled aria-busy="true"' : ""}>${experience.deletingProductId === row.productId ? "正在删除" : "删除配置"}</button>
          </div>`;
      return `<article class="teacher-experience-quota-card${unavailable ? " is-readonly" : ""}">
        <header>
          <div><h4>${escapeHtml(row.productName)}</h4>${row.productCode ? `<p>${escapeHtml(row.productCode)}</p>` : ""}</div>
          ${action}
        </header>
        <div class="teacher-experience-balance"><span>当前可用</span><strong>${row.availableCount}<small>次</small></strong></div>
        <dl class="teacher-experience-quota-facts">
          <div><dt>每月基础</dt><dd>${row.monthlyAllowance} 次</dd></div>
          <div><dt>本月已体验</dt><dd>${row.monthlyExperienceCount} 次</dd></div>
          <div><dt>单独充值</dt><dd>${row.manualRechargeCount} 次</dd></div>
          <div><dt>最近更新</dt><dd>${escapeHtml(formatTime(row.monthlyResetAt))}</dd></div>
        </dl>
      </article>`;
    }).join("");
    target.querySelectorAll("[data-experience-product-id]").forEach((button) => {
      button.addEventListener("click", () => openRecharge(button.dataset.experienceProductId));
    });
    target.querySelectorAll("[data-experience-delete-product-id]").forEach((button) => {
      button.addEventListener("click", () => void deleteExperienceConfiguration(button.dataset.experienceDeleteProductId));
    });
  }

  function totalExperienceFor(row) {
    return row.totalExperienceCount === null ? row.usedCount : row.totalExperienceCount;
  }

  function experienceSummaryRows() {
    const byProductId = new Map(experience.rows.map((row) => [row.productId, { ...row }]));
    experience.totals.forEach((total) => {
      if (!total.productId) return;
      const existing = byProductId.get(total.productId);
      if (existing) {
        existing.totalExperienceCount = total.totalExperienceCount;
        return;
      }
      byProductId.set(total.productId, {
        ...total,
        usedCount: 0,
        monthlyExperienceCount: 0,
        monthlyRechargeCount: 0,
        monthlyAllowance: 0,
        manualRechargeCount: 0,
        availableCount: 0,
        quotaMonth: "",
        monthlyResetAt: ""
      });
    });
    return [...byProductId.values()].sort((left, right) => left.productName.localeCompare(right.productName, "zh-CN"));
  }

  function renderExperienceSummary() {
    const target = $("teacherExperienceSummaryRows");
    if (!target) return;
    const rows = experienceSummaryRows();
    if (!rows.length) {
      target.innerHTML = '<div class="teacher-experience-empty"><strong>暂无项目体验数据</strong><span>配置产品并完成体验核销后，这里会按产品显示累计体验次数。</span></div>';
      return;
    }
    target.innerHTML = rows.map((row) => {
      const isAllTime = row.totalExperienceCount !== null;
      return `<article class="teacher-experience-summary-item${row.productStatus === "ARCHIVED" ? " is-archived" : ""}">
        <div><strong>${escapeHtml(row.productName)}</strong>${row.productCode ? `<span>${escapeHtml(row.productCode)}</span>` : ""}</div>
        <b>${totalExperienceFor(row)}<small>次</small></b>
        <p>${isAllTime ? "累计完成体验" : "本月体验次数"}</p>
      </article>`;
    }).join("");
  }

  function experienceEventKind(type) {
    const value = String(type || "").toUpperCase();
    if (value.includes("TOP_UP")) return "top-up";
    if (value.includes("CONSUMED")) return "consumed";
    if (value.includes("RESET")) return "reset";
    return "configuration";
  }

  function renderExperienceHistory() {
    const target = $("teacherExperienceHistoryRows");
    if (!target) return;
    const visibleHistory = experience.history.slice(0, experience.historyExpanded ? experience.history.length : 10);
    target.innerHTML = experience.history.length
      ? `${visibleHistory.map((row) => {
        const kind = experienceEventKind(row.type);
        const sign = row.count > 0 ? "+" : "";
        return `<article class="teacher-experience-history-item ${kind}">
          <span class="teacher-experience-history-dot" aria-hidden="true"></span>
          <div class="teacher-experience-history-main">
            <strong>${escapeHtml(row.type)}</strong>
            <span>${escapeHtml(row.productName)}${row.productCode ? ` · ${escapeHtml(row.productCode)}` : ""}</span>
            ${row.note ? `<small>${escapeHtml(row.note)}</small>` : ""}
          </div>
          <div class="teacher-experience-history-meta"><strong>${sign}${row.count} 次</strong><span>${escapeHtml(formatTime(row.at))}</span><small>${escapeHtml(row.actorName)}</small></div>
        </article>`;
      }).join("")}${experience.history.length > 10 ? `<button type="button" class="teacher-experience-history-toggle" data-experience-history-toggle="true">${experience.historyExpanded ? "收起记录" : `查看全部 ${experience.history.length} 条记录`}</button>` : ""}`
      : '<div class="teacher-experience-empty"><strong>暂无额度变更记录</strong><span>设置体验产品、月初更新、体验消耗和单独充值都会在这里保留记录。</span></div>';
    target.querySelector("[data-experience-history-toggle]")?.addEventListener("click", () => {
      experience.historyExpanded = !experience.historyExpanded;
      renderExperienceHistory();
    });
  }

  function renderExperienceOverview(data = {}) {
    const activeConfigured = experience.rows.filter((row) => row.productStatus === "ACTIVE").length;
    const overview = $("teacherExperienceOverview");
    $("teacherExperienceState").textContent = isStaffArchived() ? "老师已封存 · 仅可查询" : `${activeConfigured} 个配置项目`;
    overview.setAttribute("aria-busy", "false");
    overview.innerHTML = experience.rows.length
      ? experience.rows.map((row) => `<article class="teacher-experience-monthly-item">
          <header><div><strong>${escapeHtml(row.productName)}</strong>${row.productCode ? `<span>${escapeHtml(row.productCode)}</span>` : ""}</div><em>本月</em></header>
          <dl>
            <div><dt>基础额度</dt><dd>${row.monthlyAllowance}<small>次</small></dd></div>
            <div><dt>单独充值</dt><dd>${row.monthlyRechargeCount}<small>次</small></dd></div>
            <div><dt>已体验</dt><dd>${row.monthlyExperienceCount}<small>次</small></dd></div>
            <div class="available"><dt>当前可用</dt><dd>${row.availableCount}<small>次</small></dd></div>
          </dl>
        </article>`).join("")
      : '<div class="teacher-experience-empty"><strong>尚未配置体验项目</strong><span>配置后会按项目分别显示当月基础、充值、已体验和当前可用次数。</span></div>';
  }

  function renderExperience(data = {}) {
    renderExperienceOverview(data);
    renderExperienceSummary();
    renderExperienceRows();
    renderExperienceHistory();
    renderExperienceProductSelect();
    renderExperienceRechargeProductSelect();
    syncExperienceRechargeControls();
  }

  function renderExperienceProblem(title, detail) {
    const message = escapeHtml(detail || "请稍后重试。");
    const overview = $("teacherExperienceOverview");
    overview.setAttribute("aria-busy", "false");
    overview.innerHTML = `<article class="teacher-experience-problem"><strong>${escapeHtml(title)}</strong><p>${message}</p></article>`;
    $("teacherExperienceRows").innerHTML = `<div class="teacher-experience-empty is-error"><strong>${escapeHtml(title)}</strong><span>${message}</span></div>`;
    $("teacherExperienceSummaryRows").innerHTML = '<div class="teacher-experience-empty"><strong>暂无可汇总的体验数据</strong><span>服务恢复后会按产品显示累计体验次数。</span></div>';
    $("teacherExperienceHistoryRows").innerHTML = '<div class="teacher-experience-empty"><strong>暂无可显示的额度记录</strong><span>服务恢复后会显示该老师的配置、充值和体验历史。</span></div>';
    experience.rows = [];
    experience.totals = [];
    experience.history = [];
    experience.activeProducts = [];
    experience.productCatalogError = "";
    renderExperienceProductSelect();
    renderExperienceRechargeProductSelect();
    syncExperienceRechargeControls();
  }

  async function loadTeacherExperience({ preserveMessage = false } = {}) {
    if (role !== "teacher" || !staff) return;
    const panel = $("teacherExperiencePanel");
    panel.hidden = false;
    if (!hasHonoredExperienceHash && location.hash === "#teacherExperiencePanel") {
      hasHonoredExperienceHash = true;
      requestAnimationFrame(() => panel.scrollIntoView({ block: "start" }));
    }
    const id = teacherId();
    if (!id) {
      $("teacherExperienceState").textContent = "资料不完整";
      renderExperienceProblem("无法读取体验额度", "老师资料缺少数据库编号，请完善老师档案后重试。");
      setExperienceMessage("teacherExperienceConfigMessage", "老师资料缺少数据库编号，无法读取体验额度。", "error");
      return;
    }
    if (!window.CloudBasePhoneAuth?.getTeacherExperienceEntitlements) {
      $("teacherExperienceState").textContent = "服务未部署";
      renderExperienceProblem("体验额度服务尚未加载", "请部署最新后台服务后刷新本页；在服务可用前无法配置或充值。");
      setExperienceMessage("teacherExperienceConfigMessage", "体验额度服务尚未加载，请部署最新后台后重试。", "error");
      return;
    }
    experience.loading = true;
    $("teacherExperienceState").textContent = "正在读取";
    $("teacherExperienceOverview").setAttribute("aria-busy", "true");
    renderExperienceProductSelect();
    renderExperienceRechargeProductSelect();
    syncExperienceRechargeControls();
    try {
      const [entitlementResult, productResult] = await Promise.allSettled([
        window.CloudBasePhoneAuth.getTeacherExperienceEntitlements({ teacherId: id }),
        window.CloudBasePhoneAuth.listProducts()
      ]);
      if (entitlementResult.status !== "fulfilled") throw entitlementResult.reason;
      const data = entitlementResult.value;
      const products = productResult.status === "fulfilled" ? productResult.value : [];
      experience.rows = (Array.isArray(data?.entitlements) ? data.entitlements : []).map(normalizeExperienceRow).filter((row) => row.productId);
      experience.totals = (Array.isArray(data?.experienceTotals) ? data.experienceTotals : []).map(normalizeExperienceTotal).filter((row) => row.productId);
      const history = [data?.history, data?.ledger, data?.events, data?.records].find(Array.isArray) || [];
      experience.history = history.map(normalizeExperienceHistory);
      experience.productCatalogError = productResult.status === "rejected"
        ? String(productResult.reason?.message || "活跃产品目录读取失败")
        : "";
      experience.activeProducts = (Array.isArray(products) ? products : []).map((product) => ({
        id: stringValue(product, ["id", "product_id"]),
        code: stringValue(product, ["product_code", "productCode"]),
        name: stringValue(product, ["product_name", "productName"]),
        status: stringValue(product, ["product_status", "productStatus"], "ACTIVE").toUpperCase()
      })).filter((product) => product.id && product.name && product.status === "ACTIVE");
      renderExperience(data);
      if (experience.productCatalogError) {
        setExperienceMessage("teacherExperienceConfigMessage", "体验额度与历史已读取，但活跃产品目录暂不可用；已有产品仍可单独充值。请稍后刷新或部署最新后台。", "error");
      } else if (isStaffArchived()) setExperienceMessage("teacherExperienceConfigMessage", "老师已封存，体验额度与历史仍可查询，但不能新增配置或充值。", "");
      else if (!preserveMessage) setExperienceMessage("teacherExperienceConfigMessage", "");
    } catch (error) {
      $("teacherExperienceState").textContent = "读取失败";
      renderExperienceProblem("体验额度读取失败", error?.message || "请刷新页面后重试。");
      setExperienceMessage("teacherExperienceConfigMessage", error?.message || "体验额度读取失败，请稍后重试。", "error");
    } finally {
      experience.loading = false;
      renderExperienceProductSelect();
      renderExperienceRechargeProductSelect();
      syncExperienceRechargeControls();
    }
  }

  function requestId(prefix) {
    const token = window.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${token}`.slice(0, 64);
  }

  function openRecharge(productId) {
    const row = experience.rows.find((item) => item.productId === String(productId));
    if (!row) {
      setExperienceMessage("teacherExperienceRechargeMessage", "未找到该产品的体验额度配置，请刷新页面后重试。", "error");
      return;
    }
    if (row.productStatus === "ARCHIVED") {
      setExperienceMessage("teacherExperienceRechargeMessage", "该产品已封存，不能再充值体验次数。", "error");
      return;
    }
    if (!canManageTeacherExperience("rechargeTeacherExperienceEntitlement", "teacherExperienceRechargeMessage", "体验次数充值")) return;
    const select = $("teacherExperienceRechargeProduct");
    select.value = row.productId;
    $("teacherExperienceRechargeCount").value = "";
    $("teacherExperienceRechargeNote").value = "";
    experience.rechargeRequestId = "";
    setExperienceMessage("teacherExperienceRechargeMessage", "");
    setRechargeTarget(row);
    const panel = $("teacherExperienceRechargePanel");
    requestAnimationFrame(() => {
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
      $("teacherExperienceRechargeCount").focus({ preventScroll: true });
    });
  }

  function closeRecharge() {
    $("teacherExperienceRechargeProduct").value = "";
    $("teacherExperienceRechargeCount").value = "";
    $("teacherExperienceRechargeNote").value = "";
    experience.rechargeRequestId = "";
    setExperienceMessage("teacherExperienceRechargeMessage", "");
    setRechargeTarget();
  }

  async function deleteExperienceConfiguration(productId) {
    const row = experience.rows.find((item) => item.productId === String(productId));
    if (!row) {
      setExperienceMessage("teacherExperienceConfigMessage", "未找到该产品的体验额度配置，请刷新页面后重试。", "error");
      return;
    }
    if (row.productStatus !== "ACTIVE") {
      setExperienceMessage("teacherExperienceConfigMessage", "该产品已封存，当前配置仅保留作历史查询。", "error");
      return;
    }
    if (experience.deletingProductId) return;
    if (!canManageTeacherExperience("deleteTeacherExperienceEntitlement", "teacherExperienceConfigMessage", "体验额度删除")) return;
    if (!window.confirm(`确认删除“${rowProductLabel(row)}”的体验额度配置？\n\n将停止该产品的后续体验和月初更新；此前的体验、充值和变更历史会完整保留。删除后可重新配置。`)) return;
    if (!window.CloudBasePhoneAuth?.deleteTeacherExperienceEntitlement) {
      setExperienceMessage("teacherExperienceConfigMessage", "删除体验额度服务尚未加载，请部署最新后台后重试。", "error");
      return;
    }
    experience.deletingProductId = row.productId;
    renderExperienceRows();
    setExperienceMessage("teacherExperienceConfigMessage", `正在删除“${rowProductLabel(row)}”的体验额度配置…`);
    try {
      await window.CloudBasePhoneAuth.deleteTeacherExperienceEntitlement({ teacherId: teacherId(), productId: row.productId });
      if ($("teacherExperienceRechargeProduct").value === row.productId) closeRecharge();
      setExperienceMessage("teacherExperienceConfigMessage", `已删除“${rowProductLabel(row)}”的体验额度配置；现在可重新配置该产品。历史体验和充值记录仍会保留。`, "success");
      await loadTeacherExperience({ preserveMessage: true });
    } catch (error) {
      setExperienceMessage("teacherExperienceConfigMessage", error?.message || "体验额度配置删除失败。", "error");
    } finally {
      experience.deletingProductId = "";
      renderExperienceRows();
    }
  }

  function renderError(message) {
    $("staffDetailContent").innerHTML = `<div class="staff-profile-error"><strong>无法打开人员主页</strong><span>${escapeHtml(message)}</span></div>`;
    $("staffStatusHint").textContent = "未读取到可操作的账号。";
    document.querySelector(".staff-status-panel")?.setAttribute("hidden", "");
    document.querySelector(".staff-global-panel")?.setAttribute("hidden", "");
  }

  function render() {
    document.querySelector(".staff-status-panel")?.removeAttribute("hidden");
    const status = isStaffArchived() ? "封存" : "活跃";
    const isTeacher = role === "teacher";
    const staffName = stringValue(staff, ["staff_name", "teacher_name"], labels[role]);
    const teacherCode = stringValue(staff, ["person_code", "teacher_code"], "未分配");
    const initials = Array.from(staffName.trim() || labels[role]).slice(0, 1).join("");
    $("staffDetailEyebrow").textContent = isTeacher ? "TEACHER WORKSPACE" : "ACCOUNT PROFILE";
    $("staffDetailTitle").textContent = isTeacher ? `${staffName} · 老师主页` : `${staffName} · ${labels[role]}主页`;
    $("staffDetailSubtitle").textContent = isTeacher
      ? "总部在这里配置该老师的体验次数、单独充值与账号安全。"
      : "总部查看该账号自身范围的数据与账号安全。";
    $("backToManagement").href = pages[role];
    $("backToManagement").textContent = `返回${isTeacher ? "老师管理" : "总部管理"}`;
    document.title = isTeacher ? "老师主页" : `${labels[role]}主页`;
    document.querySelector(".staff-profile-workspace")?.setAttribute("aria-label", `${labels[role]}档案与账号管理`);
    $("staffSecurityTitle").textContent = `${labels[role]}账号管理`;
    $("staffDetailContent").innerHTML = isTeacher
      ? `<section class="teacher-profile-hero">
          <div class="teacher-profile-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
          <div class="teacher-profile-copy">
            <p class="teacher-profile-kicker">老师档案</p>
            <div class="teacher-profile-name-row"><h2>${escapeHtml(staffName)}</h2><span class="teacher-profile-status ${status === "活跃" ? "active" : "archived"}">${status}</span></div>
            <p class="teacher-profile-description">老师身份由登录手机号和账号主档绑定。体验核销自动使用当前老师的体验额度，现场只核验客户人脸。</p>
            <dl class="teacher-profile-meta">
              <div><dt>老师编号</dt><dd>${escapeHtml(teacherCode)}</dd></div>
              <div><dt>联系电话</dt><dd>${escapeHtml(staff.phone || "未填写")}</dd></div>
              <div><dt>密码状态</dt><dd>${escapeHtml(credentialStatus())}</dd></div>
            </dl>
          </div>
        </section>`
      : `<section class="teacher-profile-hero staff-profile-generic">
          <div class="teacher-profile-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
          <div class="teacher-profile-copy">
            <p class="teacher-profile-kicker">${escapeHtml(labels[role])}账号</p>
            <div class="teacher-profile-name-row"><h2>${escapeHtml(staffName)}</h2><span class="teacher-profile-status ${status === "活跃" ? "active" : "archived"}">${status}</span></div>
            <dl class="teacher-profile-meta">
              <div><dt>业务编号</dt><dd>${escapeHtml(stringValue(staff, ["person_code"], "未分配"))}</dd></div>
              <div><dt>联系电话</dt><dd>${escapeHtml(staff.phone || "未填写")}</dd></div>
              <div><dt>密码状态</dt><dd>${escapeHtml(credentialStatus())}</dd></div>
              <div><dt>账号编号</dt><dd>${escapeHtml(staff.auth_uid || "未记录")}</dd></div>
            </dl>
          </div>
        </section>`;
    const statusAction = $("staffStatusAction");
    statusAction.hidden = false;
    statusAction.textContent = status === "活跃" ? `封存${labels[role]}` : `激活${labels[role]}`;
    statusAction.classList.toggle("danger-button", status === "活跃");
    statusAction.classList.toggle("secondary-button", status !== "活跃");
    statusAction.disabled = false;
    statusAction.title = "";
    const baseStatusHint = status === "活跃"
      ? "封存后该人员无法登录，历史业务记录和体验额度记录都会保留。"
      : "激活后该人员可再次登录；历史业务记录保持不变。";
    delete $("staffStatusHint").dataset.tone;
    $("staffStatusHint").textContent = staff.auth_uid
      ? baseStatusHint
      : `${baseStatusHint} 该历史老师尚未关联登录账号，因此暂不能重置密码。`;
    const credentialAction = $("staffCredentialAction");
    credentialAction.hidden = !staff.auth_uid;
    credentialAction.textContent = "重置临时密码";
  }

  async function load() {
    if (!labels[role] || !personId) {
      renderError("缺少人员身份或编号。");
      return false;
    }
    try {
      const records = await window.CloudBasePhoneAuth.listStaff(role);
      staff = records.find((item) => [item.auth_uid, item.id, item.staff_id, item.teacher_id, item.teacher_code, item.person_code]
        .map((value) => String(value || "").trim())
        .includes(personId));
      if (!staff) {
        renderError("未找到该人员，可能已被删除或无权查看。");
        return false;
      }
      render();
      if (role === "teacher") await loadTeacherExperience();
      return true;
    } catch (error) {
      console.warn("人员资料读取失败", error);
      renderError("人员资料读取失败，请刷新页面后重试；如刚执行过状态操作，请先确认数据库当前状态，避免重复提交。");
      return false;
    }
  }

  $("staffCredentialAction").addEventListener("click", async () => {
    if (!staff?.auth_uid) return;
    if (!hasPhoneAuthMethod("resetStaffPassword")) {
      window.alert("密码重置服务尚未加载，请部署最新后台后刷新本页。");
      return;
    }
    const newPassword = window.prompt("输入新的临时密码（8–32 位，至少包含大写、小写、数字、特殊字符中的三类）：");
    if (newPassword === null) return;
    const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(newPassword)).length;
    if (newPassword.length < 8 || newPassword.length > 32 || groups < 3) return window.alert("密码格式不符合要求。");
    if (!window.confirm(`确认重置“${staffDisplayName()}”的密码？旧密码不会显示或保留。`)) return;
    const button = $("staffCredentialAction");
    setButtonPending(button, true, "正在重置…");
    try {
      await window.CloudBasePhoneAuth.resetStaffPassword({ uid: staff.auth_uid, newPassword });
      staff.password_change_required = true;
      staff.password_changed_at = new Date().toISOString();
      render();
      window.alert("已重置临时密码。请通过安全渠道单独告知本人。该人员下次应立即修改密码。");
    } catch (error) {
      window.alert(error?.message || "密码重置失败，请稍后重试。");
    } finally {
      setButtonPending(button, false);
      button.disabled = false;
    }
  });

  $("staffStatusAction").addEventListener("click", async () => {
    if (!staff) return;
    const masterId = role === "teacher" ? teacherId() : "";
    const canUpdateByAccount = Boolean(staff.auth_uid && hasPhoneAuthMethod("setStaffStatus"));
    const canUpdateByMaster = Boolean(masterId && hasPhoneAuthMethod("setMasterStatus"));
    if (!canUpdateByAccount && !canUpdateByMaster) {
      window.alert("账号状态服务尚未加载，或该老师缺少可用编号。请部署最新后台后刷新本页。");
      return;
    }
    const archived = isStaffArchived();
    const next = archived ? "ACTIVE" : "ARCHIVED";
    const text = archived ? "激活" : "封存";
    if (!window.confirm(`确认${text}${labels[role]}“${staffDisplayName()}”？`)) return;
    const button = $("staffStatusAction");
    setButtonPending(button, true, `${text}中…`);
    setStaffStatusFeedback(`正在${text}${labels[role]}“${staffDisplayName()}”…`, "pending");
    let requestError = null;
    try {
      // A login-bound teacher is updated through the dedicated account path,
      // which mirrors the teacher master status and CloudBase credential.
      if (canUpdateByAccount) {
        await window.CloudBasePhoneAuth.setStaffStatus({ uid: staff.auth_uid, phone: staff.phone, status: next });
      } else if (canUpdateByMaster) {
        await window.CloudBasePhoneAuth.setMasterStatus({ teacherId: masterId, status: next });
      } else {
        throw new Error("老师状态服务未加载，请刷新页面后重试。");
      }
    } catch (error) {
      requestError = error;
      console.warn(`${text}${labels[role]}请求未确认`, error);
    }
    const refreshed = await load();
    const actualArchived = staff ? isStaffArchived() : archived;
    const expectedArchived = next === "ARCHIVED";
    if (refreshed && actualArchived === expectedArchived) {
      closeRecharge();
      // The database refresh above is authoritative. Keep transport failures in
      // the console for diagnostics, but show users only the confirmed result.
      setStaffStatusFeedback(`${labels[role]}已${expectedArchived ? "封存" : "激活"}。`, "success");
    } else {
      setStaffStatusFeedback(actionableStaffStatusError(requestError, text, refreshed, actualArchived), "error");
    }
    setButtonPending(button, false);
    button.disabled = false;
  });

  $("teacherExperienceConfigForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canManageTeacherExperience("upsertTeacherExperienceEntitlement", "teacherExperienceConfigMessage", "体验额度配置")) return;
    const productId = $("teacherExperienceProduct").value;
    const monthlyAllowance = Number($("teacherExperienceMonthlyCount").value);
    if (!productId || !Number.isInteger(monthlyAllowance) || monthlyAllowance < 0 || monthlyAllowance > 99999) {
      return setExperienceMessage("teacherExperienceConfigMessage", "请选择产品，并填写 0 至 99,999 的整数体验次数。", "error");
    }
    const button = $("saveTeacherExperienceConfig");
    experience.savingConfig = true;
    setButtonPending(button, true, "正在保存…");
    renderExperienceProductSelect();
    setExperienceMessage("teacherExperienceConfigMessage", "正在保存体验额度配置…");
    try {
      await window.CloudBasePhoneAuth.upsertTeacherExperienceEntitlement({ teacherId: teacherId(), productId, monthlyAllowance });
      $("teacherExperienceMonthlyCount").value = "";
      setExperienceMessage("teacherExperienceConfigMessage", `体验额度已保存并立即生效：该产品当前可用次数现为 ${monthlyAllowance} 次；之后会在每月 1 日 00:00 按此基础额度更新。`, "success");
      await loadTeacherExperience({ preserveMessage: true });
    } catch (error) {
      setExperienceMessage("teacherExperienceConfigMessage", error?.message || "体验额度配置保存失败。", "error");
    } finally {
      experience.savingConfig = false;
      setButtonPending(button, false);
      renderExperienceProductSelect();
    }
  });

  $("teacherExperienceRechargeForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canManageTeacherExperience("rechargeTeacherExperienceEntitlement", "teacherExperienceRechargeMessage", "体验次数充值")) return;
    const productId = $("teacherExperienceRechargeProduct").value;
    const unitCount = Number($("teacherExperienceRechargeCount").value);
    const note = $("teacherExperienceRechargeNote").value.trim();
    if (!productId || !Number.isInteger(unitCount) || unitCount < 1 || unitCount > 99999) {
      return setExperienceMessage("teacherExperienceRechargeMessage", "请填写 1 至 99,999 的整数充值次数。", "error");
    }
    const button = $("saveTeacherExperienceRecharge");
    experience.savingRecharge = true;
    setButtonPending(button, true, "正在充值…");
    renderExperienceRechargeProductSelect();
    syncExperienceRechargeControls();
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
    } finally {
      experience.savingRecharge = false;
      setButtonPending(button, false);
      renderExperienceRechargeProductSelect();
      syncExperienceRechargeControls();
    }
  });

  $("cancelTeacherExperienceRecharge")?.addEventListener("click", closeRecharge);
  ["teacherExperienceRechargeProduct", "teacherExperienceRechargeCount", "teacherExperienceRechargeNote"].forEach((id) => {
    $(id)?.addEventListener("input", () => { experience.rechargeRequestId = ""; });
  });
  $("teacherExperienceRechargeProduct")?.addEventListener("change", () => {
    experience.rechargeRequestId = "";
    const row = activeRechargeRows().find((item) => item.productId === $("teacherExperienceRechargeProduct").value) || null;
    setRechargeTarget(row);
  });
  void load();
})();

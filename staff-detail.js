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
  const experience = { rows: [], totals: [], history: [], activeProducts: [], loading: false, rechargeRequestId: "", historyExpanded: false, deletingProductId: "", productCatalogError: "" };
  const teacherFaceUpdate = { imageData: "", requestId: "" };

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
    return [staff?.account_status, staff?.teacher_status, staff?.status]
      .some((value) => String(value || "").toUpperCase() === "ARCHIVED");
  }

  function teacherId() {
    return stringValue(staff, ["teacher_id", "teacherId"]);
  }

  function hasEnrolledTeacherFace() {
    return String(staff?.face_enrollment_status || staff?.faceEnrollmentStatus || "").toUpperCase() === "ENROLLED";
  }

  function setTeacherFaceUpdateMessage(message = "", tone = "") {
    const target = $("teacherFaceUpdateMessage");
    if (!target) return;
    target.textContent = message;
    target.dataset.tone = tone;
  }

  function syncTeacherFaceUpdateControls() {
    const panel = $("teacherFaceUpdatePanel");
    if (!panel || role !== "teacher") return;
    // Face enrollment is profile maintenance, not a business operation.  HQ
    // can prepare or replace a consented face while the account is archived;
    // doing so never changes the archive/login state.
    const canWrite = Boolean(staff && teacherId());
    const consent = Boolean($("teacherFaceUpdateConsent")?.checked);
    $("teacherFaceUpdateConsent").disabled = !canWrite;
    $("teacherFaceUpdateFile").disabled = !canWrite;
    $("clearTeacherFaceUpdate").disabled = !canWrite || !teacherFaceUpdate.imageData;
    $("saveTeacherFaceUpdate").disabled = !canWrite || !consent || !teacherFaceUpdate.imageData;
  }

  function clearTeacherFaceUpdate({ preserveMessage = false } = {}) {
    teacherFaceUpdate.imageData = "";
    teacherFaceUpdate.requestId = "";
    $("teacherFaceUpdateFile").value = "";
    $("teacherFaceUpdatePreview").removeAttribute("src");
    $("teacherFaceUpdatePreviewWrap").hidden = true;
    if (!preserveMessage) setTeacherFaceUpdateMessage("");
    syncTeacherFaceUpdateControls();
  }

  function openTeacherFaceUpdate() {
    if (role !== "teacher" || !staff || !teacherId()) {
      setTeacherFaceUpdateMessage("老师资料缺少可用编号，暂时无法补录人脸。", "error");
      return;
    }
    const panel = $("teacherFaceUpdatePanel");
    panel.hidden = false;
    $("teacherFaceUpdateTitle").textContent = hasEnrolledTeacherFace() ? "更换老师人脸" : "添加老师人脸";
    const archiveNote = isStaffArchived() ? "老师当前处于封存状态，补录不会恢复登录；需由总部另行激活。" : "保存不会改变老师账号的活跃状态。";
    setTeacherFaceUpdateMessage(hasEnrolledTeacherFace()
      ? `请选择一张新的老师正面照片；保存成功后，新照片会替换当前登录身份人脸。${archiveNote}`
      : `老师当前尚未绑定人脸。补录后会用于登录身份核验。${archiveNote}`, "");
    requestAnimationFrame(() => {
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
      $("teacherFaceUpdateFile").focus({ preventScroll: true });
    });
  }

  function closeTeacherFaceUpdate() {
    $("teacherFaceUpdatePanel").hidden = true;
    clearTeacherFaceUpdate();
  }

  function readTeacherFaceFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("无法读取所选照片，请重新选择。"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
  }

  async function selectTeacherFaceUpdateFile() {
    const file = $("teacherFaceUpdateFile").files?.[0];
    if (!file) return clearTeacherFaceUpdate();
    if (file.type !== "image/jpeg") {
      $("teacherFaceUpdateFile").value = "";
      return setTeacherFaceUpdateMessage("请使用 JPG 格式的老师正面照片。", "error");
    }
    if (file.size > 3 * 1024 * 1024) {
      $("teacherFaceUpdateFile").value = "";
      return setTeacherFaceUpdateMessage("照片不能超过 3 MB，请压缩后重新选择。", "error");
    }
    try {
      const imageData = await readTeacherFaceFile(file);
      if (!/^data:image\/jpeg;base64,/i.test(imageData)) throw new Error("照片格式无效，请重新选择 JPG 文件。");
      teacherFaceUpdate.imageData = imageData;
      teacherFaceUpdate.requestId = "";
      $("teacherFaceUpdatePreview").src = imageData;
      $("teacherFaceUpdatePreviewWrap").hidden = false;
      setTeacherFaceUpdateMessage("照片已就绪。勾选授权后可保存；服务端会再次检查照片质量和身份。", "");
    } catch (error) {
      clearTeacherFaceUpdate({ preserveMessage: true });
      setTeacherFaceUpdateMessage(error?.message || "读取照片失败，请重新选择。", "error");
    }
    syncTeacherFaceUpdateControls();
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
    const disabled = experience.loading || isStaffArchived() || !eligible.length;
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
    const disabled = experience.loading || isStaffArchived() || !rows.length;
    select.innerHTML = rows.length
      ? `<option value="">请选择已配置的活跃产品</option>${rows.map((row) => `<option value="${escapeHtml(row.productId)}">${escapeHtml(rowProductLabel(row))}</option>`).join("")}`
      : `<option value="">${isStaffArchived() ? "老师已封存，不能充值" : "尚无可充值的活跃产品"}</option>`;
    select.value = rows.some((row) => row.productId === previous) ? previous : "";
    select.disabled = disabled;
    setRechargeTarget(rows.find((row) => row.productId === select.value) || null);
  }

  function syncExperienceRechargeControls() {
    const disabled = experience.loading || isStaffArchived() || !activeRechargeRows().length;
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
            <button type="button" class="teacher-experience-delete-button" data-experience-delete-product-id="${escapeHtml(row.productId)}" aria-label="删除${escapeHtml(row.productName)}的体验额度配置"${experience.deletingProductId === row.productId ? " disabled" : ""}>${experience.deletingProductId === row.productId ? "正在删除" : "删除配置"}</button>
          </div>`;
      return `<article class="teacher-experience-quota-card${unavailable ? " is-readonly" : ""}">
        <header>
          <div><h4>${escapeHtml(row.productName)}</h4>${row.productCode ? `<p>${escapeHtml(row.productCode)}</p>` : ""}</div>
          ${action}
        </header>
        <div class="teacher-experience-balance"><span>当前可用</span><strong>${row.availableCount}<small>次</small></strong></div>
        <dl class="teacher-experience-quota-facts">
          <div><dt>每月基础</dt><dd>${row.monthlyAllowance} 次</dd></div>
          <div><dt>本月已体验</dt><dd>${row.usedCount} 次</dd></div>
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
    const total = numberValue(data, ["totalAvailableCount", "totalAvailable"], experience.rows.reduce((sum, row) => sum + row.availableCount, 0));
    const activeConfigured = experience.rows.filter((row) => row.productStatus === "ACTIVE").length;
    const monthlyUsedTotal = experience.rows.reduce((sum, row) => sum + row.usedCount, 0);
    const totalExperience = numberValue(
      data,
      ["totalExperienceCount", "total_experience_count"],
      experienceSummaryRows().reduce((sum, row) => sum + totalExperienceFor(row), 0)
    );
    const overview = $("teacherExperienceOverview");
    $("teacherExperienceState").textContent = isStaffArchived() ? "老师已封存 · 仅可查询" : `${activeConfigured} 个活跃产品`;
    overview.setAttribute("aria-busy", "false");
    overview.innerHTML = [
      ["当前可用", `${total}`, "次", "余额会在体验核销时扣减", "primary"],
      ["本月已体验", `${monthlyUsedTotal}`, "次", "本月已完成的体验服务", ""],
      ["累计体验", `${totalExperience}`, "次", "各项目累计完成次数", ""],
      ["月初自动更新", "每月 1 日 00:00", "", "仅更新活跃老师的活跃产品", "muted"]
    ].map(([label, value, unit, note, tone]) => `<article class="${tone}"><span>${label}</span><strong>${value}${unit ? `<small>${unit}</small>` : ""}</strong><p>${note}</p></article>`).join("");
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
    if (!row || row.productStatus === "ARCHIVED" || isStaffArchived()) return;
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
    if (!row || row.productStatus !== "ACTIVE" || isStaffArchived() || experience.deletingProductId) return;
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
    const status = isStaffArchived() ? "封存" : "活跃";
    const isTeacher = role === "teacher";
    const staffName = stringValue(staff, ["staff_name", "teacher_name"], labels[role]);
    const teacherCode = stringValue(staff, ["person_code", "teacher_code"], "未分配");
    const enrollment = String(staff.face_enrollment_status || staff.faceEnrollmentStatus || "").toUpperCase();
    const faceStatus = enrollment === "ENROLLED" ? "已绑定 · 可随时更换" : "待补录 · 不影响激活";
    const initials = Array.from(staffName.trim() || labels[role]).slice(0, 1).join("");
    $("staffDetailEyebrow").textContent = isTeacher ? "TEACHER WORKSPACE" : "ACCOUNT PROFILE";
    $("staffDetailTitle").textContent = isTeacher ? `${staffName} · 老师主页` : `${staffName} · ${labels[role]}主页`;
    $("staffDetailSubtitle").textContent = isTeacher
      ? "总部在这里配置该老师的体验次数、单独充值与账号安全。"
      : "总部查看该账号自身范围的数据与账号安全。";
    $("backToManagement").href = pages[role];
    $("staffDetailContent").innerHTML = isTeacher
      ? `<section class="teacher-profile-hero">
          <div class="teacher-profile-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
          <div class="teacher-profile-copy">
            <p class="teacher-profile-kicker">老师档案</p>
            <div class="teacher-profile-name-row"><h2>${escapeHtml(staffName)}</h2><span class="teacher-profile-status ${status === "活跃" ? "active" : "archived"}">${status}</span></div>
            <p class="teacher-profile-description">老师账号可先激活；人脸可在后续补录或更换。体验核销将记入该老师名下的体验额度，不会扣减客户购买次数。</p>
            <dl class="teacher-profile-meta">
              <div><dt>老师编号</dt><dd>${escapeHtml(teacherCode)}</dd></div>
              <div><dt>联系电话</dt><dd>${escapeHtml(staff.phone || "未填写")}</dd></div>
              <div class="teacher-face-status-fact"><dt>人脸绑定</dt><dd>${escapeHtml(faceStatus)}</dd></div>
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
    const baseStatusHint = status === "活跃"
      ? "封存后该人员无法登录，历史业务记录和体验额度记录都会保留。"
      : "激活后该人员可再次登录；历史业务记录保持不变。";
    $("staffStatusHint").textContent = staff.auth_uid
      ? baseStatusHint
      : `${baseStatusHint} 该历史老师尚未关联登录账号，因此暂不能重置密码。`;
    const credentialAction = $("staffCredentialAction");
    credentialAction.hidden = !staff.auth_uid;
    credentialAction.textContent = "重置临时密码";
    const faceAction = $("staffFaceAction");
    faceAction.hidden = !isTeacher;
    if (isTeacher) {
      faceAction.textContent = hasEnrolledTeacherFace() ? "更换人脸" : "添加人脸";
      faceAction.disabled = !teacherId();
      faceAction.title = isStaffArchived()
        ? "老师已封存，不能登录或办理业务；总部仍可补录或更换人脸，且不会改变封存状态。"
        : "可在账号创建后补录或更换人脸。";
    }
    syncTeacherFaceUpdateControls();
  }

  async function load() {
    if (!labels[role] || !personId) return renderError("缺少人员身份或编号。");
    try {
      const records = await window.CloudBasePhoneAuth.listStaff(role);
      staff = records.find((item) => [item.auth_uid, item.id, item.staff_id, item.teacher_id, item.teacher_code, item.person_code]
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
      // A login-bound teacher is updated through the dedicated account path,
      // which atomically mirrors the teacher master status and the CloudBase
      // credential.  No face-enrollment condition exists in that path.
      if (staff.auth_uid && window.CloudBasePhoneAuth?.setStaffStatus) {
        await window.CloudBasePhoneAuth.setStaffStatus({ uid: staff.auth_uid, phone: staff.phone, status: next });
      } else if (masterId && window.CloudBasePhoneAuth?.setMasterStatus) {
        await window.CloudBasePhoneAuth.setMasterStatus({ teacherId: masterId, status: next });
      } else {
        throw new Error("老师状态服务未加载，请刷新页面后重试。");
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

  $("staffFaceAction")?.addEventListener("click", openTeacherFaceUpdate);
  $("closeTeacherFaceUpdate")?.addEventListener("click", closeTeacherFaceUpdate);
  $("clearTeacherFaceUpdate")?.addEventListener("click", () => clearTeacherFaceUpdate());
  $("teacherFaceUpdateConsent")?.addEventListener("change", syncTeacherFaceUpdateControls);
  $("teacherFaceUpdateFile")?.addEventListener("change", () => void selectTeacherFaceUpdateFile());
  $("teacherFaceUpdateForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!staff || role !== "teacher" || !teacherId()) return;
    if (!$("teacherFaceUpdateConsent").checked || !teacherFaceUpdate.imageData) {
      setTeacherFaceUpdateMessage("请选择照片并确认已取得老师明确授权。", "error");
      syncTeacherFaceUpdateControls();
      return;
    }
    if (!window.CloudBasePhoneAuth?.upsertTeacherFace) {
      setTeacherFaceUpdateMessage("人脸补录服务尚未加载，请部署最新后台后刷新本页。", "error");
      return;
    }
    const button = $("saveTeacherFaceUpdate");
    button.disabled = true;
    setTeacherFaceUpdateMessage("正在安全保存老师人脸，请勿关闭页面…");
    try {
      const result = await window.CloudBasePhoneAuth.upsertTeacherFace({
        teacherId: teacherId(),
        faceImageBase64: teacherFaceUpdate.imageData,
        clientRequestId: teacherFaceUpdate.requestId || (teacherFaceUpdate.requestId = requestId("teacher_face_update")),
        consent: true
      });
      const updated = result?.teacher || result?.profile || {};
      Object.assign(staff, updated);
      staff.face_enrollment_status = stringValue(updated, ["faceEnrollmentStatus", "face_enrollment_status"], "ENROLLED");
      staff.faceEnrollmentStatus = staff.face_enrollment_status;
      clearTeacherFaceUpdate({ preserveMessage: true });
      render();
      $("teacherFaceUpdateTitle").textContent = "更换老师人脸";
      setTeacherFaceUpdateMessage("老师人脸已保存。账号活跃状态未改变，之后仍可按授权再次更换。", "success");
    } catch (error) {
      setTeacherFaceUpdateMessage(error?.message || "老师人脸保存失败，请稍后重试。", "error");
    } finally {
      syncTeacherFaceUpdateControls();
    }
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
      setExperienceMessage("teacherExperienceConfigMessage", `体验额度已保存并立即生效：该产品当前可用次数现为 ${monthlyAllowance} 次；之后会在每月 1 日 00:00 按此基础额度更新。`, "success");
      await loadTeacherExperience({ preserveMessage: true });
    } catch (error) {
      setExperienceMessage("teacherExperienceConfigMessage", error?.message || "体验额度配置保存失败。", "error");
    } finally { button.disabled = false; }
  });

  $("teacherExperienceRechargeForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!staff || isStaffArchived()) return;
    const productId = $("teacherExperienceRechargeProduct").value;
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

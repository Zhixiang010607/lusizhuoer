(() => {
  "use strict";

  const PAGE_SIZE = 20;
  const EXPORT_LIMIT = 1000;
  const RATING_TIME_OPTIONS = Object.freeze([
    { value: "TODAY", label: "今天" },
    { value: "ALL", label: "全部时间" },
    { value: "LAST_7", label: "近 7 天" },
    { value: "LAST_MONTH", label: "近 1 个月" },
    { value: "QUARTER", label: "本季度" },
    { value: "YEAR", label: "本年度" },
    { value: "CUSTOM", label: "自定义日期" }
  ]);
  const type = document.body.dataset.operationMetric;
  const $ = (id) => document.getElementById(id);
  const state = {
    stores: [], products: [], teachers: [], scores: new Set([0, 1, 2, 3, 4, 5]),
    loading: false, searched: false, total: 0, summary: {}, ratingPage: 1, ratingPages: 1,
    ratingRows: [], categories: {
      ZERO: { page: 1, pages: 1, total: 0, rows: [], cursors: [null] },
      NONZERO: { page: 1, pages: 1, total: 0, rows: [], cursors: [null] }
    }
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const clean = (value) => String(value ?? "").trim();

  function businessToday() {
    const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function dateParts(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
  }

  function dateText(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function addDays(value, amount) {
    const parts = dateParts(value);
    if (!parts) return "";
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    date.setUTCDate(date.getUTCDate() + amount);
    return dateText(date);
  }

  function ratingTimeRange(value, custom = {}) {
    const period = String(value || "TODAY").toUpperCase();
    const today = businessToday();
    const current = dateParts(today);
    if (period === "TODAY") return { startDate: today, endDate: today };
    if (period === "ALL") return { startDate: "", endDate: "" };
    if (period === "CUSTOM") return { startDate: custom.startDate || today, endDate: custom.endDate || today };
    if (period === "LAST_7") return { startDate: addDays(today, -6), endDate: today };
    if (period === "LAST_MONTH") {
      const start = new Date(Date.UTC(current.year, current.month - 1, current.day));
      start.setUTCMonth(start.getUTCMonth() - 1);
      return { startDate: dateText(start), endDate: today };
    }
    if (period === "QUARTER") return { startDate: `${current.year}-${String(Math.floor((current.month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`, endDate: today };
    if (period === "YEAR") return { startDate: `${current.year}-01-01`, endDate: today };
    return { startDate: today, endDate: today };
  }

  function resultObject(raw, marker) {
    const parse = (value) => {
      if (value && typeof value === "object") return value;
      try { return JSON.parse(value); } catch (_) { return null; }
    };
    return [raw?.result, raw?.data?.result, raw?.data, raw].map(parse).find((value) => value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, marker)) || {};
  }

  async function invokeFunction(name, data, marker = "ok") {
    const app = window.cloudbase.init(window.CloudBaseAuthConfig);
    const raw = await app.callFunction({ name, data });
    const payload = resultObject(raw, marker);
    const succeeded = marker === "success" ? payload.success === true : payload.ok === true;
    if (!succeeded) {
      const error = new Error(payload?.error?.message || payload.message || "服务器没有返回有效结果");
      error.code = payload?.error?.code || payload.code || "BUSINESS_REQUEST_FAILED";
      throw error;
    }
    return marker === "success" ? payload.data || {} : payload;
  }

  function callFace(action, data) { return invokeFunction("faceRecognition", { action, ...data }); }
  function callRating(action, data = {}) { return invokeFunction("customerRating", { action, ...data }, "success"); }

  function setMessage(message = "", tone = "") {
    $("operationsMessage").textContent = message;
    $("operationsMessage").dataset.tone = tone;
  }

  function setBusy(busy, message = "") {
    state.loading = busy;
    document.querySelectorAll("#operationsFilters input, #operationsFilters select, #operationsFilters button").forEach((control) => { control.disabled = busy; });
    if (message) setMessage(message);
  }

  function optionMarkup(rows, label, value = "") {
    return `<option value="">${escapeHtml(label)}</option>${rows.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.label || row.name)}</option>`).join("")}`.replace(`value="${escapeHtml(value)}"`, `value="${escapeHtml(value)}" selected`);
  }

  function mapStores(rows = []) {
    return rows.map((row) => ({ id: clean(row.id || row.store_id), name: clean(row.name || row.store_name || row.storeName) || "未命名门店", label: clean(row.name || row.store_name || row.storeName) || "未命名门店" })).filter((row) => row.id);
  }

  function mapProducts(rows = []) {
    return rows.map((row) => ({ id: clean(row.id || row.product_id), name: clean(row.name || row.product_name || row.productName) || "未命名项目", label: clean(row.name || row.product_name || row.productName) || "未命名项目" })).filter((row) => row.id);
  }

  function standardActions() {
    return `<div class="operations-filter-actions"><button id="operationsSearch" type="button">开始查询</button><button id="operationsReset" class="secondary-button" type="button">重置</button></div>`;
  }

  function selectOptions(values, selected, suffix) {
    return values.map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${value} ${suffix}</option>`).join("");
  }

  function chineseDateMarkup(id, label, value) {
    const today = dateParts(businessToday());
    const selected = dateParts(value) || today;
    const years = Array.from({ length: today.year - 1990 + 1 }, (_, index) => today.year - index);
    const months = Array.from({ length: 12 }, (_, index) => index + 1);
    const days = Array.from({ length: 31 }, (_, index) => index + 1);
    return `<label class="operations-date-field" data-date-field="${id}"><span>${label}</span><input id="${id}" type="hidden" value="${escapeHtml(value)}"><span class="operations-date-selectors"><select id="${id}Year" aria-label="${label}年份">${selectOptions(years, selected.year, "年")}</select><select id="${id}Month" aria-label="${label}月份">${selectOptions(months, selected.month, "月")}</select><select id="${id}Day" aria-label="${label}日期">${selectOptions(days, selected.day, "日")}</select></span></label>`;
  }

  function updateChineseDate(id) {
    const hidden = $(id);
    const year = Number($(`${id}Year`)?.value);
    const monthSelect = $(`${id}Month`);
    const daySelect = $(`${id}Day`);
    if (!hidden || !year || !monthSelect || !daySelect) return;
    const today = dateParts(businessToday());
    const maximumMonth = year === today.year ? today.month : 12;
    const month = Math.min(Math.max(1, Number(monthSelect.value) || 1), maximumMonth);
    monthSelect.innerHTML = selectOptions(Array.from({ length: maximumMonth }, (_, index) => index + 1), month, "月");
    const calendarDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const maximumDay = year === today.year && month === today.month ? Math.min(calendarDays, today.day) : calendarDays;
    const selectedDay = Math.min(Math.max(1, Number(daySelect.value) || 1), maximumDay);
    daySelect.innerHTML = selectOptions(Array.from({ length: maximumDay }, (_, index) => index + 1), selectedDay, "日");
    hidden.value = `${year}-${String(month).padStart(2, "0")}-${String(selectedDay).padStart(2, "0")}`;
  }

  function setChineseDate(id, value) {
    const selected = dateParts(value) || dateParts(businessToday());
    $(`${id}Year`).value = String(selected.year);
    $(`${id}Month`).value = String(selected.month);
    $(`${id}Day`).value = String(selected.day);
    updateChineseDate(id);
  }

  function bindChineseDate(id) {
    for (const part of ["Year", "Month", "Day"]) {
      $(`${id}${part}`).addEventListener("change", () => { updateChineseDate(id); clearResults(); });
    }
    updateChineseDate(id);
  }

  function applyRatingPeriod(period) {
    const isCustom = period === "CUSTOM";
    document.querySelectorAll("[data-rating-custom-date]").forEach((field) => { field.hidden = !isCustom; });
    const range = ratingTimeRange(period, { startDate: $("operationsStart")?.value, endDate: $("operationsEnd")?.value });
    if (range.startDate) setChineseDate("operationsStart", range.startDate);
    else $("operationsStart").value = "";
    if (range.endDate) setChineseDate("operationsEnd", range.endDate);
    else $("operationsEnd").value = "";
  }

  function renderFilters() {
    if (type === "inactive") {
      $("operationsFilters").innerHTML = `<label>门店范围<select id="operationsStore">${optionMarkup(state.stores, "全部门店")}</select></label><label>核销间隔至少多少天<input id="operationsThreshold" type="number" min="1" max="3650" placeholder="例如：30"></label>${standardActions()}`;
      $("operationsRules").textContent = "有正常核销时取最新正常核销；没有正常核销才取最新体验核销；两类都没有时取客户建档时间。只查询未封存客户。";
    } else if (type === "balance") {
      $("operationsFilters").innerHTML = `<label>门店范围<select id="operationsStore">${optionMarkup(state.stores, "全部门店")}</select></label><label>项目范围<select id="operationsProduct">${optionMarkup(state.products, "全部项目")}</select></label><label>剩余次数严格低于<input id="operationsThreshold" type="number" min="1" max="1000000" placeholder="例如：5"></label>${standardActions()}`;
      $("operationsRules").textContent = "结果对象是客户与项目的卡项组合，只查询未封存客户；项目余次为 0 和非 0 但低于阈值分开显示。";
    } else {
      const today = businessToday();
      const teacherOptions = `<option value="">全部老师</option><option value="NONE">未指定老师</option>${state.teachers.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.label || row.name)}</option>`).join("")}`;
      const periodOptions = RATING_TIME_OPTIONS.map((item) => `<option value="${item.value}" ${item.value === "TODAY" ? "selected" : ""}>${item.label}</option>`).join("");
      $("operationsFilters").innerHTML = `<label>门店范围<select id="operationsStore">${optionMarkup(state.stores, "全部门店")}</select></label><label>项目范围<select id="operationsProduct">${optionMarkup(state.products, "全部项目")}</select></label><label>老师范围<select id="operationsTeacher">${teacherOptions}</select></label><label>时间范围<select id="operationsPeriod">${periodOptions}</select></label><div data-rating-custom-date hidden>${chineseDateMarkup("operationsStart", "开始日期", today)}</div><div data-rating-custom-date hidden>${chineseDateMarkup("operationsEnd", "结束日期", today)}</div>${standardActions()}<div class="operations-score-filter" aria-label="最低评分">${[0, 1, 2, 3, 4, 5].map((score) => `<button class="active" type="button" data-score="${score}">${score === 0 ? "0 未评价" : `${score} 分`}</button>`).join("")}</div>`;
      $("operationsRules").textContent = "查询允许选择 0–5 分；0 分只代表未评价。评分分布只统计已评价的 1–5 分，未评价只进入评价覆盖率。";
      bindChineseDate("operationsStart");
      bindChineseDate("operationsEnd");
      $("operationsPeriod").addEventListener("change", (event) => { applyRatingPeriod(event.target.value); clearResults(); });
      document.querySelectorAll("[data-score]").forEach((button) => button.addEventListener("click", () => {
        const score = Number(button.dataset.score);
        if (state.scores.has(score) && state.scores.size === 1) { setMessage("至少保留一个评分条件", "error"); return; }
        if (state.scores.has(score)) state.scores.delete(score); else state.scores.add(score);
        button.classList.toggle("active", state.scores.has(score));
        clearResults();
      }));
    }
    $("operationsSearch").addEventListener("click", search);
    $("operationsReset").addEventListener("click", reset);
    $("operationsFilters").querySelectorAll("input, select").forEach((control) => control.addEventListener("change", clearResults));
  }

  function clearResults() {
    state.searched = false; state.total = 0; state.ratingRows = []; state.ratingPage = 1; state.ratingPages = 1;
    state.categories.ZERO = { page: 1, pages: 1, total: 0, rows: [], cursors: [null] };
    state.categories.NONZERO = { page: 1, pages: 1, total: 0, rows: [], cursors: [null] };
    $("operationsSummary").hidden = true;
    $("operationsResults").innerHTML = '<div class="operations-empty">填写条件后开始查询</div>';
    $("operationsExport").disabled = true; $("operationsPrint").disabled = true;
    setMessage();
  }

  function basePayload() {
    const payload = { limit: PAGE_SIZE };
    const storeId = clean($("operationsStore")?.value);
    if (storeId) payload.storeId = storeId;
    if (type === "inactive") payload.minimumDays = clean($("operationsThreshold").value);
    if (type === "balance") {
      payload.remainingBelow = clean($("operationsThreshold").value);
      const productId = clean($("operationsProduct").value);
      if (productId) payload.productId = productId;
    }
    return payload;
  }

  function categoryAction() { return type === "inactive" ? "queryInactiveVerificationCustomers" : "queryLowBalanceCustomers"; }
  function sectionRows(section) { return type === "inactive" ? section?.customers : section?.balances; }
  function categoryLabels(category) {
    if (type === "inactive") return category === "ZERO" ? "全部项目为 0" : "任意项目非 0";
    return category === "ZERO" ? "项目余次为 0" : "非 0 且低于阈值";
  }

  function validateThreshold() {
    const value = clean($("operationsThreshold")?.value);
    const number = Number(value);
    const max = type === "inactive" ? 3650 : 1000000;
    if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < 1 || number > max) throw new Error(`请输入 1 至 ${max} 的整数`);
  }

  function ratingPayload(page = 1, pageSize = PAGE_SIZE) {
    const startDate = $("operationsStart").value;
    const endDate = $("operationsEnd").value;
    if ((!startDate && endDate) || (startDate && !endDate)) throw new Error("开始日期和结束日期必须同时填写");
    if (startDate > endDate) throw new Error("开始日期不能晚于结束日期");
    if (startDate && (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 > 366) throw new Error("自定义时间范围不能超过 366 天");
    const payload = { pageNumber: page, pageSize, startDate, endDate, scores: [...state.scores].sort() };
    for (const [id, key] of [["operationsStore", "storeId"], ["operationsProduct", "productId"], ["operationsTeacher", "teacherId"]]) {
      const value = clean($(id)?.value); if (value) payload[key] = value;
    }
    return payload;
  }

  async function search() {
    if (state.loading) return;
    try {
      if (type !== "rating") validateThreshold();
      setBusy(true, type === "rating" ? "正在读取评价工单…" : "正在读取客户…");
      if (type === "rating") await loadRating(1); else await loadBoth();
    } catch (error) {
      setMessage(error?.message || "查询失败，请重试", "error");
    } finally { setBusy(false); }
  }

  async function loadBoth() {
    const result = await callFace(categoryAction(), { ...basePayload(), balanceCategory: "BOTH" });
    for (const category of ["ZERO", "NONZERO"]) {
      const section = result.sections?.[category];
      const rows = sectionRows(section);
      if (!Array.isArray(rows)) throw new Error("运营查询服务版本过旧，请先部署最新服务");
      const total = Number(section.categoryTotal || 0);
      state.categories[category] = { page: 1, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, rows, cursors: [null, section.nextCursor || null] };
    }
    state.summary = result.summary || {};
    state.total = Number(state.summary.selectedTotal || 0);
    state.searched = true;
    renderSummary(); renderCategoryResults(); enableExports(); setMessage(`查询完成，共 ${state.total} 条结果`);
  }

  async function loadCategory(category, targetPage) {
    if (state.loading) return;
    const bucket = state.categories[category];
    if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > bucket.pages) return;
    setBusy(true, `正在读取${categoryLabels(category)}第 ${targetPage} 页…`);
    try {
      while (targetPage > 1 && !bucket.cursors[targetPage - 1]) {
        const discoveryPage = bucket.cursors.length;
        const discovery = await fetchCategory(category, bucket.cursors[discoveryPage - 1]);
        if (!discovery.hasMore || !discovery.nextCursor) break;
        bucket.cursors[discoveryPage] = discovery.nextCursor;
      }
      if (targetPage > 1 && !bucket.cursors[targetPage - 1]) throw new Error("目标页已超出当前结果");
      const result = await fetchCategory(category, bucket.cursors[targetPage - 1]);
      bucket.page = targetPage;
      bucket.rows = type === "inactive" ? result.customers || [] : result.balances || [];
      if (result.hasMore && result.nextCursor) bucket.cursors[targetPage] = result.nextCursor;
      renderCategoryResults(); setMessage();
    } catch (error) { setMessage(error?.message || "分页读取失败", "error"); }
    finally { setBusy(false); }
  }

  function fetchCategory(category, cursor) {
    const payload = { ...basePayload(), balanceCategory: category };
    if (cursor) {
      if (type === "inactive") { payload.cursorBaselineAt = cursor.baselineAt; payload.cursorCustomerId = cursor.customerId; }
      else { payload.cursorRemainingCount = cursor.remainingCount; payload.cursorCustomerId = cursor.customerId; payload.cursorProductId = cursor.productId; }
    }
    return callFace(categoryAction(), payload);
  }

  async function loadRating(page) {
    const result = await callRating("queryRatingAnalysis", ratingPayload(page));
    state.ratingRows = result.orders || [];
    state.ratingPage = Math.max(1, Number(result.pageNumber || 1));
    state.ratingPages = Math.max(1, Number(result.totalPages || 1));
    state.total = Number(result.total || 0); state.summary = result.summary || {};
    state.searched = true;
    renderSummary(); renderRatingResults(); enableExports(); setMessage(`查询完成，共 ${state.total} 单`);
  }

  function renderSummary() {
    let values;
    if (type === "inactive") values = [["匹配客户", state.summary.selectedTotal], ["全部项目为 0", state.summary.zeroBalanceCustomers], ["任意项目非 0", state.summary.nonzeroBalanceCustomers]];
    else if (type === "balance") values = [["匹配卡项", state.summary.selectedTotal], ["项目余次为 0", state.summary.zeroBalance], ["非 0 且低于阈值", state.summary.nonzeroBelowThreshold]];
    else {
      const total = Number(state.summary.total || state.total || 0); const rated = Number(state.summary.rated || 0);
      values = [["全部工单", total], ["已评价", rated], ["评价覆盖率", total ? `${(rated * 100 / total).toFixed(1)}%` : "0.0%"]];
    }
    $("operationsSummary").innerHTML = values.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 0)}</strong></article>`).join("");
    $("operationsSummary").hidden = false;
  }

  function customerLink(row) {
    const code = clean(row.customerCode);
    return code ? `<a href="customer-detail.html?customerId=${encodeURIComponent(code)}">${escapeHtml(row.customerName || "—")}</a>` : escapeHtml(row.customerName || "—");
  }

  function pager(category, bucket) {
    if (bucket.pages <= 1) return "";
    return `<div class="operations-pager"><button type="button" data-page-action="previous" data-category="${category}" ${bucket.page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${bucket.page} / ${bucket.pages} 页</span><input type="number" min="1" max="${bucket.pages}" value="${bucket.page}" data-page-input="${category}" aria-label="跳转页码"><button type="button" data-page-action="jump" data-category="${category}">跳转</button><button type="button" data-page-action="next" data-category="${category}" ${bucket.page >= bucket.pages ? "disabled" : ""}>下一页</button></div>`;
  }

  function renderCategoryResults() {
    $("operationsResults").innerHTML = ["ZERO", "NONZERO"].map((category) => {
      const bucket = state.categories[category];
      const head = type === "inactive" ? ["客户", "门店", "间隔时间", "计算起点", "上次核销"] : ["客户", "门店", "项目", "购入", "已使用", "剩余"];
      const body = bucket.rows.map((row) => type === "inactive"
        ? `<tr><td>${customerLink(row)}</td><td>${escapeHtml(row.storeName || "—")}</td><td>${Number(row.daysSince || 0)} 天</td><td>${escapeHtml(({ NORMAL: "正常核销", EXPERIENCE: "体验核销", CUSTOMER_CREATED: "客户建档" })[clean(row.baselineSource).toUpperCase()] || "客户建档")}</td><td>${escapeHtml(clean(row.baselineSource).toUpperCase() === "CUSTOMER_CREATED" ? "从未核销" : row.baselineAt || "—")}</td></tr>`
        : `<tr><td>${customerLink(row)}</td><td>${escapeHtml(row.storeName || "—")}</td><td>${escapeHtml(row.productName || "—")}</td><td>${Number(row.purchasedCount || 0)} 次</td><td>${Number(row.consumedCount || 0)} 次</td><td><strong>${Number(row.remainingCount || 0)} 次</strong></td></tr>`).join("");
      return `<section class="operations-section"><div class="operations-section-heading"><h3>${categoryLabels(category)}</h3><span class="badge">${bucket.total} 条</span></div>${body ? `<div class="operations-table-scroll"><table class="operations-table"><thead><tr>${head.map((label) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>` : '<div class="operations-empty">当前条件下没有这类结果</div>'}${pager(category, bucket)}</section>`;
    }).join("");
    bindPagers();
  }

  function renderRatingResults() {
    const body = state.ratingRows.map((row) => {
      const id = clean(row.id); const code = clean(row.recordCode); const category = clean(row.verificationType || "NORMAL").toUpperCase();
      const order = id ? `<a href="verification-detail.html?recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}&category=${encodeURIComponent(category)}">${escapeHtml(code || "—")}</a>` : escapeHtml(code || "—");
      const score = Number(row.effectiveScore || 0);
      return `<tr><td>${order}</td><td>${customerLink(row)}</td><td>${escapeHtml(row.storeName || "—")}</td><td>${escapeHtml(row.productName || "—")}</td><td>${escapeHtml(row.teacherName || "未指定")}</td><td>${escapeHtml(row.serviceTime || "—")}</td><td>${score ? `${score} 分` : "未评价"}</td><td>${score ? `${Number(row.storeEnvironmentScore || 0)} 分` : "—"}</td><td>${score && row.teacherName ? `${Number(row.teacherServiceScore || 0)} 分` : "—"}</td><td>${score ? `${Number(row.overallExperienceScore || 0)} 分` : "—"}</td></tr>`;
    }).join("");
    const bucket = { page: state.ratingPage, pages: state.ratingPages };
    $("operationsResults").innerHTML = body ? `<div class="operations-table-scroll"><table class="operations-table"><thead><tr><th>工单号</th><th>客户</th><th>门店</th><th>项目</th><th>老师</th><th>服务时间</th><th>最低分</th><th>门店环境</th><th>老师服务</th><th>整体体验</th></tr></thead><tbody>${body}</tbody></table></div>${pager("RATING", bucket)}` : '<div class="operations-empty">当前条件下没有匹配工单</div>';
    bindPagers();
  }

  function bindPagers() {
    document.querySelectorAll("[data-page-action]").forEach((button) => button.addEventListener("click", async () => {
      const category = button.dataset.category; const action = button.dataset.pageAction;
      if (category === "RATING") {
        let target = action === "previous" ? state.ratingPage - 1 : action === "next" ? state.ratingPage + 1 : Number(document.querySelector('[data-page-input="RATING"]').value);
        if (!Number.isInteger(target) || target < 1 || target > state.ratingPages || state.loading) return;
        setBusy(true, `正在读取第 ${target} 页…`); try { await loadRating(target); } catch (error) { setMessage(error?.message || "分页读取失败", "error"); } finally { setBusy(false); }
        return;
      }
      const bucket = state.categories[category];
      const target = action === "previous" ? bucket.page - 1 : action === "next" ? bucket.page + 1 : Number(document.querySelector(`[data-page-input="${category}"]`).value);
      void loadCategory(category, target);
    }));
  }

  function enableExports() {
    const enabled = state.total > 0 && state.total <= EXPORT_LIMIT;
    $("operationsExport").disabled = !enabled; $("operationsPrint").disabled = !enabled;
    if (state.total > EXPORT_LIMIT) setMessage(`当前结果超过 ${EXPORT_LIMIT} 条，请缩小查询范围后导出`, "error");
  }

  async function allRows() {
    if (type === "rating") return (await callRating("queryRatingAnalysis", { ...ratingPayload(1, EXPORT_LIMIT), exportAll: true })).orders || [];
    const result = await callFace(categoryAction(), { ...basePayload(), limit: EXPORT_LIMIT, balanceCategory: "BOTH", exportAll: true });
    return type === "inactive" ? result.exportCustomers || [] : result.exportBalances || [];
  }

  function exportColumns() {
    if (type === "inactive") return [["customerName", "客户"], ["storeName", "门店"], ["daysSince", "间隔天数"], ["baselineSource", "计算起点"], ["baselineAt", "上次核销"]];
    if (type === "balance") return [["customerName", "客户"], ["storeName", "门店"], ["productName", "项目"], ["purchasedCount", "购入次数"], ["consumedCount", "已使用"], ["remainingCount", "剩余次数"]];
    return [["recordCode", "工单号"], ["customerName", "客户"], ["storeName", "门店"], ["productName", "项目"], ["teacherName", "老师"], ["serviceTime", "服务时间"], ["effectiveScore", "最低分"], ["storeEnvironmentScore", "门店环境"], ["teacherServiceScore", "老师服务"], ["overallExperienceScore", "整体体验"]];
  }

  async function exportRows(format) {
    if (state.loading || !state.searched || state.total < 1 || state.total > EXPORT_LIMIT) return;
    setBusy(true, `正在准备 ${state.total} 条完整结果…`);
    try {
      const rows = await allRows();
      if (rows.length !== state.total) throw new Error("完整结果数量已变化，请重新查询后导出");
      const columns = exportColumns();
      if (format === "csv") {
        const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const csv = [columns.map(([, label]) => quote(label)).join(","), ...rows.map((row) => columns.map(([key]) => quote(row[key])).join(","))].join("\r\n");
        const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); link.download = `${document.title}-${businessToday()}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      } else {
        const printWindow = window.open("", "_blank");
        if (!printWindow) throw new Error("浏览器阻止了打印窗口，请允许弹出窗口后重试");
        printWindow.document.write(`<meta charset="utf-8"><title>${escapeHtml(document.title)}</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;padding:24px;color:#302a22}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #d8c5a3;text-align:center}th{background:#f4e7d0}h1{font-size:24px}</style><h1>${escapeHtml(document.title)}</h1><p>导出日期：${businessToday()} · 共 ${rows.length} 条</p><table><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(row[key] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        printWindow.document.close(); printWindow.focus(); printWindow.print();
      }
      setMessage(`已准备 ${rows.length} 条完整结果`);
    } catch (error) { setMessage(error?.message || "导出失败", "error"); }
    finally { setBusy(false); }
  }

  function reset() {
    if (type === "rating") state.scores = new Set([0, 1, 2, 3, 4, 5]);
    renderFilters(); clearResults();
  }

  $("operationsRulesToggle").addEventListener("click", () => { $("operationsRules").hidden = !$("operationsRules").hidden; });
  $("operationsExport").addEventListener("click", () => exportRows("csv"));
  $("operationsPrint").addEventListener("click", () => exportRows("print"));

  (async () => {
    $("operationsResults").innerHTML = '<div class="operations-empty">正在读取查询选项…</div>';
    try {
      if (type === "rating") {
        const options = await callRating("getRatingAnalysisOptions");
        state.stores = mapStores(options.stores); state.products = mapProducts(options.products);
        state.teachers = (options.teachers || []).map((row) => ({ id: clean(row.id), name: clean(row.name) || "未命名老师", label: clean(row.name) || "未命名老师" })).filter((row) => row.id);
      } else {
        const tasks = [window.CloudBasePhoneAuth.listStores()];
        if (type === "balance") tasks.push(window.CloudBasePhoneAuth.listProducts());
        const [stores, products] = await Promise.all(tasks);
        state.stores = mapStores(stores); state.products = mapProducts(products || []);
      }
      renderFilters(); clearResults();
    } catch (error) {
      renderFilters(); clearResults(); setMessage(error?.message || "查询选项读取失败，请刷新页面重试", "error");
    }
  })();
})();

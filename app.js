(() => {
  "use strict";

  // 文档同步约束：每次业务或界面变更都必须同步更新 main.tex 与 README.md。
  const PROTOTYPE_VERSION = "0.15.18";
  const BUSINESS_TIME_ZONE = "Asia/Shanghai";
  const RANKING_PAGE_SIZE = 100;
  const PRODUCT_SUMMARY_PAGE_SIZE = 10;
  const RANKING_MAX_PAGE_NUMBER = 10000;
  const PDF_EXPORT_PAGE_SIZE = 500;
  const PDF_EXPORT_MAX_ROWS = 10000;
  const EMPTY_DATA = Object.freeze({
    stores: [],
    teachers: [],
    projects: [],
    rows: [],
    teacherRows: [],
    totals: { recharge: 0, verification: 0, experience: 0, refund: 0, stores: 0, teachers: 0 }
  });
  const EMPTY_RANKING = Object.freeze({
    dimension: "store",
    rankingMetric: "recharge",
    productId: "",
    pageNumber: 1,
    pageSize: RANKING_PAGE_SIZE,
    total: 0,
    totalPages: 1,
    accessibleTotalPages: 1,
    businessTotal: 0,
    rankingTotal: 0,
    rows: [],
    error: ""
  });
  const EMPTY_PRODUCT_SUMMARY = Object.freeze({
    pageNumber: 1,
    pageSize: PRODUCT_SUMMARY_PAGE_SIZE,
    total: 0,
    totalPages: 1,
    rows: [],
    error: ""
  });

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("zh-CN");
  const state = {
    data: EMPTY_DATA,
    breakdowns: new Set(),
    view: document.body.dataset.view || "global",
    requestSequence: 0,
    requestState: "idle",
    requestError: "",
    retryable: false,
    loadedAt: null,
    range: null,
    ranking: EMPTY_RANKING,
    rankingLoading: false,
    rankingRequestSequence: 0,
    rankingMetric: "recharge",
    rankingProductId: "",
    rankingProducts: [],
    productSummary: EMPTY_PRODUCT_SUMMARY,
    productSummaryLoading: false,
    productSummaryRequestSequence: 0,
    exporting: false
  };
  const dimensionLabels = { store: "门店", project: "项目", teacher: "老师" };
  const rankingMetricLabels = { recharge: "充值", verification: "核销", experience: "体验", refund: "退费" };
  const dateFilters = ["period", "dateFrom", "dateTo"];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function finiteCount(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function finiteNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function pick(source, ...keys) {
    for (const key of keys) {
      if (source?.[key] !== null && source?.[key] !== undefined && source[key] !== "") return source[key];
    }
    return "";
  }

  function entityLabel(name, code, fallback) {
    const cleanName = String(name || "").trim();
    const cleanCode = String(code || "").trim();
    if (cleanName && cleanCode && !cleanName.includes(cleanCode)) return `${cleanName} · ${cleanCode}`;
    return cleanName || cleanCode || fallback;
  }

  function chartEntityLabelMarkup(value) {
    const text = String(value || "").trim();
    const separator = " · ";
    const separatorIndex = text.lastIndexOf(separator);
    if (separatorIndex <= 0) {
      return `<span class="bar-label-name">${escapeHtml(text)}</span>`;
    }
    const name = text.slice(0, separatorIndex);
    const code = text.slice(separatorIndex + separator.length);
    return `<span class="bar-label-name">${escapeHtml(name)}</span><span class="bar-label-code">${escapeHtml(code)}</span>`;
  }

  function normalizeRows(rows, teacherContext = false) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const storeId = String(pick(row, "storeId", "store_id"));
      const projectId = String(pick(row, "projectId", "productId", "product_id"));
      const teacherId = String(pick(row, "teacherId", "teacher_id"));
      return {
        storeId,
        store: entityLabel(
          pick(row, "store", "storeName", "store_name"),
          pick(row, "storeCode", "store_code"),
          storeId ? `门店 ${storeId}` : "未指定门店"
        ),
        projectId,
        project: entityLabel(
          pick(row, "project", "product", "productName", "product_name"),
          "",
          projectId ? "未命名项目" : "未指定项目"
        ),
        teacherId,
        teacher: teacherContext ? entityLabel(
          pick(row, "teacher", "teacherName", "teacher_name"),
          pick(row, "teacherCode", "teacher_code"),
          teacherId ? `老师 ${teacherId}` : "未指定老师"
        ) : "",
        recharge: finiteNumber(pick(row, "recharge", "rechargeCount", "recharge_count")),
        verification: finiteCount(pick(row, "verification", "verificationCount", "verification_count")),
        experience: finiteCount(pick(row, "experience", "experienceCount", "experience_count")),
        refund: finiteCount(pick(row, "refund", "refundCount", "refund_count"))
      };
    });
  }

  function normalizeChartRows(rows, dimension) {
    if (!Array.isArray(rows)) return [];
    const source = rows.map((row) => {
      const entityId = pick(row, "entityId", "entity_id");
      const entityCode = pick(row, "entityCode", "entity_code");
      const entityName = pick(row, "entityName", "entity_name");
      if (dimension === "store") {
        return { ...row, storeId: entityId, storeCode: entityCode, storeName: entityName };
      }
      if (dimension === "project") {
        return { ...row, productId: entityId, productCode: entityCode, productName: entityName };
      }
      return { ...row, teacherId: entityId, teacherCode: entityCode, teacherName: entityName };
    });
    return normalizeRows(source, dimension === "teacher");
  }

  function normalizeRanking(payload, fallbackDimension = "store") {
    const source = payload?.ranking && typeof payload.ranking === "object" ? payload.ranking : payload;
    if (!source || typeof source !== "object") throw new Error("总部排名返回的数据格式不正确");
    const dimension = ["store", "project", "teacher"].includes(String(source.dimension || ""))
      ? String(source.dimension)
      : fallbackDimension;
    const rankingMetric = Object.prototype.hasOwnProperty.call(rankingMetricLabels, String(source.rankingMetric || ""))
      ? String(source.rankingMetric)
      : state.rankingMetric;
    const rows = Array.isArray(source.rows) ? source.rows.map((row) => {
      const entityId = String(pick(row, "entityId", "entity_id"));
      const entityCode = String(pick(row, "entityCode", "entity_code"));
      const entityName = String(pick(row, "entityName", "entity_name"));
      return {
        entityId,
        entityCode,
        entityName,
        name: entityLabel(entityName, entityCode, entityId ? `${dimensionLabels[dimension]} ${entityId}` : "未指定对象"),
        recharge: finiteNumber(pick(row, "recharge", "rechargeCount", "recharge_count")),
        verification: finiteCount(pick(row, "verification", "verificationCount", "verification_count")),
        experience: finiteCount(pick(row, "experience", "experienceCount", "experience_count")),
        refund: finiteCount(pick(row, "refund", "refundCount", "refund_count"))
      };
    }) : [];
    const pageSize = Math.max(1, finiteCount(pick(source, "pageSize", "page_size"), RANKING_PAGE_SIZE));
    const total = finiteCount(pick(source, "total", "totalRows", "total_rows"), rows.length);
    const totalPages = Math.max(1, finiteCount(pick(source, "totalPages", "total_pages"), Math.ceil(total / pageSize)));
    const accessibleTotalPages = Math.min(totalPages, RANKING_MAX_PAGE_NUMBER);
    return {
      dimension,
      rankingMetric,
      productId: String(pick(source, "productId", "product_id") || ""),
      pageNumber: Math.min(accessibleTotalPages, Math.max(1, finiteCount(pick(source, "pageNumber", "page_number"), 1))),
      pageSize,
      total,
      totalPages,
      accessibleTotalPages,
      businessTotal: finiteCount(pick(source, "businessTotal", "business_total"), 0),
      rankingTotal: finiteCount(pick(source, "rankingTotal", "ranking_total"), 0),
      rows,
      error: ""
    };
  }

  function normalizeProductSummary(payload) {
    const source = payload?.productSummary;
    if (!source || typeof source !== "object" || !Array.isArray(source.rows)) {
      throw new Error("总部项目汇总服务版本过旧，请先部署 staffAccount v76");
    }
    const rows = source.rows.map((row) => ({
      entityId: String(pick(row, "entityId", "entity_id")),
      name: String(pick(row, "entityName", "entity_name") || "未命名项目"),
      recharge: finiteNumber(pick(row, "recharge", "rechargeCount", "recharge_count")),
      verification: finiteCount(pick(row, "verification", "verificationCount", "verification_count")),
      experience: finiteCount(pick(row, "experience", "experienceCount", "experience_count")),
      refund: finiteCount(pick(row, "refund", "refundCount", "refund_count"))
    }));
    const pageSize = Math.max(1, finiteCount(pick(source, "pageSize", "page_size"), PRODUCT_SUMMARY_PAGE_SIZE));
    const total = finiteCount(pick(source, "total", "totalRows", "total_rows"), rows.length);
    const totalPages = Math.max(1, finiteCount(pick(source, "totalPages", "total_pages"), Math.ceil(total / pageSize)));
    return {
      pageNumber: Math.min(totalPages, Math.max(1, finiteCount(pick(source, "pageNumber", "page_number"), 1))),
      pageSize,
      total,
      totalPages,
      rows,
      error: ""
    };
  }

  function normalizeDashboard(payload, requestedRange) {
    const source = payload?.dashboard && typeof payload.dashboard === "object" ? payload.dashboard : payload;
    if (!source || typeof source !== "object") throw new Error("数据库返回的数据格式不正确");
    const charts = source.charts && typeof source.charts === "object" ? source.charts : null;
    const stores = charts ? normalizeChartRows(charts.store || charts.stores, "store") : normalizeRows(source.stores);
    const rows = charts ? normalizeChartRows(charts.project || charts.projects, "project") : normalizeRows(source.rows);
    const teacherRows = charts
      ? normalizeChartRows(charts.teacher || charts.teachers, "teacher")
      : normalizeRows(source.teacherRows || source.teacher_rows, true);
    const totals = source.totals || {};
    const derivedRecharge = rows.reduce((sum, row) => sum + row.recharge, 0);
    const derivedVerification = rows.reduce((sum, row) => sum + row.verification, 0);
    const derivedExperience = rows.reduce((sum, row) => sum + row.experience, 0);
    const derivedRefund = rows.reduce((sum, row) => sum + row.refund, 0);
    const derivedStores = stores.length || new Set(rows.map((row) => row.storeId).filter(Boolean)).size;
    const derivedTeachers = new Set(teacherRows.map((row) => row.teacherId).filter(Boolean)).size;
    return {
      stores,
      teachers: Array.isArray(source.teachers) ? source.teachers : [],
      projects: Array.isArray(source.projects) ? source.projects : [],
      rows,
      teacherRows,
      totals: {
        recharge: finiteNumber(pick(totals, "recharge", "rechargeCount", "recharge_count"), derivedRecharge),
        verification: finiteCount(pick(totals, "verification", "verificationCount", "verification_count"), derivedVerification),
        experience: finiteCount(pick(totals, "experience", "experienceCount", "experience_count"), derivedExperience),
        refund: finiteCount(pick(totals, "refund", "refundCount", "refund_count"), derivedRefund),
        stores: finiteCount(pick(totals, "stores", "storeCount", "store_count"), derivedStores),
        teachers: finiteCount(pick(totals, "teachers", "teacherCount", "teacher_count"), derivedTeachers)
      },
      range: {
        startDate: String(pick(source.range, "startDate", "start_date") || requestedRange.startDate),
        endDate: String(pick(source.range, "endDate", "end_date") || requestedRange.endDate),
        timeZone: String(pick(source.range, "timeZone", "time_zone") || BUSINESS_TIME_ZONE)
      }
    };
  }

  function businessToday() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  }

  function toDateInput(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function setPeriodDates(period) {
    const today = businessToday();
    const year = today.getUTCFullYear();
    let start;
    let end = new Date(today);
    if (period === "today") {
      start = new Date(today);
    } else if (period === "thisWeek") {
      const weekday = today.getUTCDay() || 7;
      start = new Date(today);
      start.setUTCDate(today.getUTCDate() - weekday + 1);
    } else if (period === "thisMonth") {
      start = new Date(Date.UTC(year, today.getUTCMonth(), 1));
    } else if (period === "last7" || period === "last30") {
      const days = period === "last7" ? 7 : 30;
      start = new Date(today);
      start.setUTCDate(today.getUTCDate() - days + 1);
    } else if (period === "ytd") {
      start = new Date(Date.UTC(year, 0, 1));
    } else if (/^q[1-4]$/.test(period)) {
      const quarter = Number(period.slice(1));
      start = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
      const naturalEnd = new Date(Date.UTC(year, quarter * 3, 0));
      end = start > today ? naturalEnd : new Date(Math.min(naturalEnd.getTime(), today.getTime()));
    } else {
      return;
    }
    $("dateFrom").value = toDateInput(start);
    $("dateTo").value = toDateInput(end);
    $("dateFrom").syncChineseDate?.();
    $("dateTo").syncChineseDate?.();
  }

  function parseDateInput(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
    const [year, month, day] = String(value).split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return toDateInput(parsed) === value ? parsed : null;
  }

  function selectedRange() {
    const startDate = $("dateFrom").value;
    const endDate = $("dateTo").value;
    const start = parseDateInput(startDate);
    const end = parseDateInput(endDate);
    if (!start || !end) return { valid: false, message: "请选择完整的开始日期和结束日期" };
    if (start > end) return { valid: false, message: "开始日期不能晚于结束日期" };
    const today = businessToday();
    if (start > today || end > today) return { valid: false, message: "统计日期不能晚于今天" };
    const days = Math.floor((end - start) / 86400000) + 1;
    if (days > 366) return { valid: false, message: "单次统计范围不能超过 366 天" };
    return { valid: true, startDate, endDate, days };
  }

  function fillSelect(id, items, valueKey, labelKey) {
    const select = $(id);
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = valueKey ? item[valueKey] : item;
      option.textContent = labelKey ? item[labelKey] : item;
      select.append(option);
    });
  }

  function currentData() {
    const storeId = $("store").value;
    const project = $("project").value;
    const teacherId = $("teacher").value;
    const q = $("search").value.trim().toLowerCase();
    const rows = state.data.rows.filter((r) =>
      (storeId === "all" || r.storeId === storeId) &&
      (project === "all" || r.project === project) &&
      (!q || `${r.store} ${r.storeId} ${r.project}`.toLowerCase().includes(q))
    );
    const teacherRows = state.data.teacherRows.filter((r) =>
      (storeId === "all" || r.storeId === storeId) &&
      (teacherId === "all" || r.teacherId === teacherId) &&
      (project === "all" || r.project === project) &&
      (!q || `${r.store} ${r.storeId} ${r.teacher} ${r.teacherId} ${r.project}`.toLowerCase().includes(q))
    );
    const localViewNeedsObject = state.view === "local" && selectedDimensions().length === 0;
    return { rows: localViewNeedsObject ? [] : rows, teacherRows: localViewNeedsObject ? [] : teacherRows };
  }

  function aggregate(rows, key, rankingMetric = "recharge") {
    const map = new Map();
    rows.forEach((r) => {
      const name = r[key];
      const item = map.get(name) || { name, recharge: 0, verification: 0, experience: 0, refund: 0 };
      item.recharge += r.recharge || 0;
      item.verification += r.verification || 0;
      item.experience += r.experience || 0;
      item.refund += r.refund || 0;
      map.set(name, item);
    });
    return [...map.values()].sort((a, b) => (b[rankingMetric] || 0) - (a[rankingMetric] || 0));
  }

  function selectedDimensions() {
    return ["store", "project", "teacher"].filter((key) => $(key).value !== "all");
  }

  function availableBreakdowns() {
    const selected = new Set(selectedDimensions());
    return ["store", "project", "teacher"].filter((key) => !selected.has(key));
  }

  function resetBreakdowns() {
    const selected = selectedDimensions();
    state.breakdowns = new Set(selected.length ? availableBreakdowns() : []);
  }

  function renderBreakdownControls() {
    const selected = selectedDimensions();
    const container = $("breakdownControls");
    if (!selected.length) {
      container.innerHTML = state.view === "global"
        ? `<strong>全局视图</strong><span class="breakdown-note">固定显示按门店、按项目、按老师三张统计图</span>`
        : `<strong>局部分析</strong><span class="breakdown-note">请从门店、项目或业务老师下拉框中选择一个具体对象</span>`;
      return;
    }
    const options = availableBreakdowns();
    if (!options.length) {
      container.innerHTML = `<strong>分类方式</strong><span class="breakdown-note">已定位到具体门店、项目和老师，请查看指标卡与明细</span>`;
      return;
    }
    container.innerHTML = `<strong>分类方式</strong>${options.map((key) => `<label><input type="checkbox" data-breakdown="${key}" ${state.breakdowns.has(key) ? "checked" : ""}>按${dimensionLabels[key]}分类</label>`).join("")}<span class="breakdown-note">可同时勾选多个分类维度</span>`;
    container.querySelectorAll("[data-breakdown]").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) state.breakdowns.add(input.dataset.breakdown);
      else if (state.breakdowns.size > 1) state.breakdowns.delete(input.dataset.breakdown);
      else input.checked = true;
      const { rows, teacherRows } = currentData();
      renderAnalysis(rows, teacherRows);
      renderRanking(rows, teacherRows);
    }));
  }

  function renderProductSummary() {
    const summary = state.productSummary || EMPTY_PRODUCT_SUMMARY;
    const totals = state.data.totals || {};
    $("productSummaryBadge").textContent = `共 ${fmt.format(summary.total || 0)} 个项目`;
    if (state.productSummaryLoading) {
      $("productSummaryBody").innerHTML = `<div class="hq-project-summary-empty">正在读取全部项目汇总…</div>`;
    } else if (summary.error) {
      $("productSummaryBody").innerHTML = `<div class="hq-project-summary-empty">${escapeHtml(summary.error)}</div>`;
    } else if (!summary.rows.length) {
      $("productSummaryBody").innerHTML = `<div class="hq-project-summary-empty">当前没有项目</div>`;
    } else {
      $("productSummaryBody").innerHTML = summary.rows.map((row) => `<div class="hq-project-summary-row" role="row"><span role="cell" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span><span role="cell">${fmt.format(row.verification)} 次</span><span role="cell">${fmt.format(row.recharge)} 次</span><span role="cell">${fmt.format(row.experience)} 次</span><span role="cell">${fmt.format(row.refund)} 次</span></div>`).join("");
    }
    $("productSummaryRecharge").textContent = fmt.format(finiteNumber(totals.recharge, 0));
    $("productSummaryVerification").textContent = fmt.format(finiteCount(totals.verification, 0));
    $("productSummaryExperience").textContent = fmt.format(finiteCount(totals.experience, 0));
    $("productSummaryRefund").textContent = fmt.format(finiteCount(totals.refund, 0));
    const multiplePages = summary.totalPages > 1;
    $("productSummaryPager").hidden = !multiplePages;
    $("productSummaryPageLabel").textContent = `第 ${fmt.format(summary.pageNumber)} / ${fmt.format(summary.totalPages)} 页`;
    $("productSummaryPrevious").disabled = state.productSummaryLoading || summary.pageNumber <= 1;
    $("productSummaryNext").disabled = state.productSummaryLoading || summary.pageNumber >= summary.totalPages;
  }

  function limited(items) {
    return $("limit").value === "all" ? items : items.slice(0, Number($("limit").value));
  }

  function flexibleAxis(maxValue, targetIntervals = 5) {
    if (!Number.isFinite(maxValue) || maxValue <= 0) {
      return { max: 5, step: 1, ticks: [0, 1, 2, 3, 4, 5] };
    }
    const roughStep = maxValue / targetIntervals;
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const normalized = roughStep / magnitude;
    const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    const step = factor * magnitude;
    const max = Math.ceil(maxValue / step) * step;
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
    return { max, step, ticks };
  }

  function signedAxis(values) {
    const minimum = Math.min(0, ...values);
    const maximum = Math.max(0, ...values);
    if (minimum >= 0) {
      const positive = flexibleAxis(maximum);
      return { min: 0, max: positive.max, step: positive.step, ticks: positive.ticks };
    }
    const positive = flexibleAxis(Math.max(Math.abs(minimum), maximum), 4);
    const ticks = [];
    for (let tick = -positive.max; tick <= positive.max; tick += positive.step) ticks.push(tick);
    return { min: -positive.max, max: positive.max, step: positive.step, ticks };
  }

  function barChartMarkup(sourceRows, dimension, rankingMetric = "recharge") {
    const items = limited(aggregate(sourceRows, dimension, rankingMetric));
    if (!items.length) return `<div class="empty-state">当前筛选与分类范围内暂无有效数据</div>`;
    const series = ["recharge", "verification", "experience", "refund"];
    const values = items.flatMap((x) => series.map((key) => x[key]));
    const axis = signedAxis(values);
    const axisRange = axis.max - axis.min;
    const tickMarkup = axis.ticks.map((tick) => {
      const top = 20 + (axis.max - tick) / axisRange * 240;
      return `<span class="bar-axis-tick" style="top:${top}px">${fmt.format(tick)}</span>`;
    }).join("");
    const gridMarkup = axis.ticks.map((tick) => {
      const top = 20 + (axis.max - tick) / axisRange * 240;
      return `<i class="bar-grid-line ${tick === 0 ? "zero" : ""}" style="top:${top}px"></i>`;
    }).join("");
    const barsMarkup = items.map((x) => {
      const safeName = escapeHtml(x.name);
      const safeTitle = escapeHtml(`${x.name}：有效充值 ${fmt.format(x.recharge)} 次，有效核销 ${fmt.format(x.verification)} 次，有效体验 ${fmt.format(x.experience)} 次，有效退费 ${fmt.format(x.refund)} 次；打开明细`);
      return `<button class="bar-group" type="button" data-name="${safeName}" title="${safeTitle}" aria-label="${safeTitle}"><span class="bars">${series.map((key, index) => {
        const value = x[key];
        const top = (axis.max - Math.max(value, 0)) / axisRange * 100;
        const height = Math.abs(value) / axisRange * 100;
        const valueTop = value < 0 ? top + height : top;
        const valueClass = value < 0 ? "negative" : value === 0 ? "zero" : "positive";
        return `<i class="bar ${key} ${value < 0 ? "negative" : ""} ${value === 0 ? "zero-value" : ""}" aria-hidden="true" style="--bar-index:${index};top:${top}%;height:${height}%"></i><span class="bar-value ${key} ${valueClass}" aria-hidden="true" style="--bar-index:${index};top:${valueTop}%">${escapeHtml(fmt.format(value))}</span>`;
      }).join("")}</span><span class="bar-label" aria-hidden="true">${chartEntityLabelMarkup(x.name)}</span></button>`;
    }).join("");
    const hasNegative = values.some((value) => value < 0);
    const legend = `<span><i class="legend-dot" style="background:#1f5eff"></i>有效充值</span><span><i class="legend-dot" style="background:#00a884"></i>有效核销</span><span><i class="legend-dot" style="background:#7c3aed"></i>有效体验</span><span><i class="legend-dot" style="background:#d97706"></i>有效退费</span>${hasNegative ? `<span><i class="legend-dot" style="background:#b42318"></i>历史冲销（负值）</span>` : ""}`;
    const maximumTotal = Math.max(1, ...items.map((item) => item[rankingMetric] || 0));
    const mobileRows = items.map((item, index) => {
      const total = item[rankingMetric] || 0;
      const width = Math.max(total ? 4 : 0, total / maximumTotal * 100).toFixed(1);
      const safeName = escapeHtml(item.name);
      return `<button class="dashboard-top-row" type="button" data-name="${safeName}"><span class="dashboard-top-head"><strong>第 ${index + 1} 名</strong><b>${safeName}</b><em>${fmt.format(total)} 次</em></span><span class="dashboard-top-track"><i style="width:${width}%"></i></span><span class="dashboard-top-metrics"><span>充值<b>${fmt.format(item.recharge)}</b></span><span>核销<b>${fmt.format(item.verification)}</b></span><span>体验<b>${fmt.format(item.experience)}</b></span><span>退费<b>${fmt.format(item.refund)}</b></span></span></button>`;
    }).join("");
    return `<div class="mobile-dashboard-top-list">${mobileRows}</div><div class="bar-scroll desktop-dashboard-chart"><div class="chart-legend">${legend}<span>纵轴：次数 · 间隔 ${fmt.format(axis.step)}</span></div><div class="bar-chart-body"><div class="bar-y-axis"><strong>次数</strong>${tickMarkup}</div><div class="bar-plot-scroll"><div class="bar-canvas" aria-label="纵轴从${axis.min}到${axis.max}次，每${axis.step}次一个刻度">${gridMarkup}${barsMarkup}</div></div></div></div>`;
  }

  function rankingControlsMarkup(activeDimension) {
    const productControl = `<label class="dashboard-ranking-product"><span>项目范围</span><select id="dashboardRankingProduct"><option value="">全部项目</option>${state.rankingProducts.map((product) => `<option value="${escapeHtml(product.id)}" ${product.id === state.rankingProductId ? "selected" : ""}>${escapeHtml(product.label)}</option>`).join("")}</select></label>`;
    return `<div class="dashboard-ranking-control"><span class="dashboard-control-label">排名对象</span><div class="dashboard-dimension-tabs" aria-label="排名对象">${["store", "teacher"].map((dimension) => `<button type="button" data-dashboard-dimension="${dimension}" class="${dimension === activeDimension ? "active" : ""}">${dimensionLabels[dimension]}</button>`).join("")}</div></div>${productControl}<div class="dashboard-ranking-control"><span class="dashboard-control-label">排序指标</span><div class="dashboard-dimension-tabs dashboard-metric-tabs" aria-label="排序指标">${Object.entries(rankingMetricLabels).map(([metric, label]) => `<button type="button" data-dashboard-metric="${metric}" class="${metric === state.rankingMetric ? "active" : ""}">${label}</button>`).join("")}</div></div>`;
  }

  function renderAnalysis(rows, teacherRows) {
    const dimension = rankingDimension();
    if ($("dashboardRankingControls")) $("dashboardRankingControls").innerHTML = rankingControlsMarkup(dimension);
  }

  function rankingDimension() {
    const selector = $("rankingDimension");
    if (selector) return selector.value;
    const selected = selectedDimensions();
    return selected.length ? ([...state.breakdowns][0] || selected[0]) : "store";
  }

  function renderRankingPager() {
    const previous = $("rankingPreviousPage");
    const next = $("rankingNextPage");
    const input = $("rankingPageInput");
    const jump = $("rankingPageJump");
    const label = $("rankingPageLabel");
    const retry = $("rankingRetry");
    if (!previous || !next || !input || !jump || !label || !retry) return;
    const ranking = state.ranking || EMPTY_RANKING;
    const totalPages = Math.max(1, Number(ranking.accessibleTotalPages || ranking.totalPages || 1));
    const pageNumber = Math.min(totalPages, Math.max(1, Number(ranking.pageNumber || 1)));
    const pageLimitReached = Number(ranking.totalPages || 1) > totalPages;
    const disabled = state.requestState !== "ready" || state.rankingLoading || state.exporting || Boolean(ranking.error);
    previous.disabled = disabled || pageNumber <= 1;
    next.disabled = disabled || pageNumber >= totalPages;
    input.disabled = disabled;
    input.min = "1";
    input.max = String(totalPages);
    input.value = String(pageNumber);
    jump.disabled = disabled;
    retry.hidden = !ranking.error;
    retry.disabled = state.requestState !== "ready" || state.rankingLoading || state.exporting;
    label.textContent = ranking.error
      ? "排名读取失败"
      : pageLimitReached
        ? `第 ${fmt.format(pageNumber)} / ${fmt.format(totalPages)} 页 · 共 ${fmt.format(ranking.total || 0)} 条（最多浏览前 ${fmt.format(totalPages * Math.max(1, Number(ranking.pageSize || RANKING_PAGE_SIZE)))} 条）`
        : `第 ${fmt.format(pageNumber)} / ${fmt.format(totalPages)} 页 · 共 ${fmt.format(ranking.total || 0)} 条`;
  }

  function renderRanking() {
    const ranking = state.ranking || EMPTY_RANKING;
    const dimension = ranking.dimension || rankingDimension();
    const rankingMetric = ranking.rankingMetric || state.rankingMetric;
    const productName = state.rankingProductId
      ? state.rankingProducts.find((product) => product.id === state.rankingProductId)?.label || "指定项目"
      : "全部项目";
    if ($("rankingRule")) $("rankingRule").textContent = `${productName} · 按${dimensionLabels[dimension]}的${rankingMetricLabels[rankingMetric]}次数降序；每页 100 条`;
    if (ranking.error) {
      $("rankingBody").innerHTML = `<tr class="dashboard-ranking-empty"><td colspan="8">${escapeHtml(ranking.error)}</td></tr>`;
      renderRankingPager();
      return;
    }
    const total = Math.max(1, Number(ranking.rankingTotal || 0));
    const pageOffset = (Math.max(1, Number(ranking.pageNumber || 1)) - 1) * Math.max(1, Number(ranking.pageSize || RANKING_PAGE_SIZE));
    $("rankingBody").innerHTML = ranking.rows.map((row, index) => {
      const safeName = escapeHtml(row.name);
      return `<tr data-name="${safeName}"><td class="dashboard-rank-cell">第 ${fmt.format(pageOffset + index + 1)} 名</td><td class="dashboard-name-cell">${safeName}</td><td class="dashboard-dimension-cell">按${dimensionLabels[dimension]}</td><td data-label="充值">${fmt.format(row.recharge)}</td><td data-label="核销">${fmt.format(row.verification)}</td><td data-label="体验">${fmt.format(row.experience)}</td><td data-label="退费">${fmt.format(row.refund)}</td><td class="dashboard-share-cell" data-label="${rankingMetricLabels[rankingMetric]}占比">${((row[rankingMetric] || 0) / total * 100).toFixed(1)}%</td></tr>`;
    }).join("") || `<tr class="dashboard-ranking-empty"><td colspan="8">当前日期范围暂无有效数据</td></tr>`;
    renderRankingPager();
  }

  function renderScope() {
    const text = `${$("dateFrom").value} 至 ${$("dateTo").value} · ${$("store").selectedOptions[0].text} · ${$("project").selectedOptions[0].text} · ${$("teacher").selectedOptions[0].text}`;
    const updatedAt = state.loadedAt ? state.loadedAt.toLocaleTimeString("zh-CN", { hour12: false }) : "—";
    $("scopeText").textContent = `当前统计范围：${text}；客户范围：全部客户（含活跃及已存档）；数据库更新：${updatedAt}`;
  }

  function render() {
    const { rows, teacherRows } = currentData();
    renderBreakdownControls();
    renderProductSummary();
    renderAnalysis(rows, teacherRows);
    renderRanking(rows, teacherRows);
    renderScope();
  }

  function showDetail(type) {
    $("detailText").textContent = `${type}；${$("scopeText").textContent}`;
    $("detailDialog").showModal();
  }

  function openDashboardQuery(type) {
    const page = ["recharge", "refund"].includes(type) ? "recharge-query.html" : "verification-query.html";
    const params = new URLSearchParams({
      drill: type,
      startDate: $("dateFrom").value,
      endDate: $("dateTo").value
    });
    window.location.assign(`${page}?${params.toString()}`);
  }

  function toggleDashboardDateFields() {
    const custom = $("period").value === "custom";
    document.querySelectorAll(".dashboard-custom-date").forEach((field) => { field.hidden = !custom; });
  }

  async function exportPdf() {
    if (state.requestState !== "ready" || state.exporting) return;
    const range = selectedRange();
    if (!range.valid) return;
    const dimension = rankingDimension();
    const rankingMetric = state.rankingMetric;
    const productId = state.rankingProductId;
    const currentRanking = state.ranking || EMPTY_RANKING;
    if (currentRanking.error) {
      window.alert("排名尚未读取成功，暂时不能导出。请先重试排名读取。");
      return;
    }
    if (state.productSummary?.error) {
      window.alert("项目汇总尚未读取成功，暂时不能导出完整报表。请先重新读取首页数据。");
      return;
    }
    if (Number(currentRanking.total || 0) > PDF_EXPORT_MAX_ROWS) {
      window.alert(`当前${dimensionLabels[dimension] || "分类"}排名共有 ${fmt.format(currentRanking.total)} 条。为避免浏览器内存占用，单次 PDF 最多导出 ${fmt.format(PDF_EXPORT_MAX_ROWS)} 条；请缩小统计日期范围后重试。`);
      return;
    }
    if (!window.HqDashboardReport?.downloadReport) {
      window.alert("矢量 PDF 导出组件尚未加载，请刷新页面后重试。");
      return;
    }
    const exportButton = $("exportBtn");
    const originalLabel = exportButton.textContent;
    state.exporting = true;
    setControlsLoading(true);
    try {
      const productRows = [];
      let productPageNumber = 1;
      let productTotalPages = 1;
      do {
        exportButton.textContent = `正在读取项目汇总 ${productPageNumber} / ${productTotalPages}…`;
        const payload = await window.CloudBasePhoneAuth.getHqDashboard({
          startDate: range.startDate,
          endDate: range.endDate,
          mode: "product-summary",
          pageNumber: productPageNumber,
          pageSize: PDF_EXPORT_PAGE_SIZE
        });
        const page = normalizeProductSummary(payload);
        if (page.total > PDF_EXPORT_MAX_ROWS) {
          throw new Error(`项目汇总共有 ${fmt.format(page.total)} 项，单次 PDF 最多绘制 ${fmt.format(PDF_EXPORT_MAX_ROWS)} 项。`);
        }
        if (productRows.length + page.rows.length > PDF_EXPORT_MAX_ROWS) {
          throw new Error(`单次 PDF 最多绘制 ${fmt.format(PDF_EXPORT_MAX_ROWS)} 个项目，已停止继续读取。`);
        }
        productTotalPages = page.totalPages;
        productRows.push(...page.rows);
        productPageNumber += 1;
      } while (productPageNumber <= productTotalPages);

      const rankingRows = [];
      let pageNumber = 1;
      let totalPages = 1;
      let rankingTotal = Number(currentRanking.rankingTotal || 0);
      do {
        exportButton.textContent = `正在读取完整排名 ${pageNumber} / ${totalPages}…`;
        const payload = await window.CloudBasePhoneAuth.getHqDashboard({
          startDate: range.startDate,
          endDate: range.endDate,
          mode: "ranking",
          dimension,
          rankingMetric,
          productId,
          pageNumber,
          pageSize: PDF_EXPORT_PAGE_SIZE
        });
        const page = normalizeRanking(payload, dimension);
        if (page.dimension !== dimension || page.rankingMetric !== rankingMetric || page.productId !== productId) {
          throw new Error("总部排名导出范围与当前选择不一致");
        }
        if (page.total > PDF_EXPORT_MAX_ROWS) {
          throw new Error(`当前${dimensionLabels[dimension] || "分类"}排名共有 ${fmt.format(page.total)} 条。为避免浏览器内存占用，单次 PDF 最多导出 ${fmt.format(PDF_EXPORT_MAX_ROWS)} 条；请缩小统计日期范围后重试。`);
        }
        if (rankingRows.length + page.rows.length > PDF_EXPORT_MAX_ROWS) {
          throw new Error(`单次 PDF 最多导出 ${fmt.format(PDF_EXPORT_MAX_ROWS)} 条排名，已停止继续读取。请缩小统计日期范围后重试。`);
        }
        totalPages = page.totalPages;
        rankingTotal = Number(page.rankingTotal || rankingTotal || 0);
        rankingRows.push(...page.rows);
        pageNumber += 1;
      } while (pageNumber <= totalPages);

      exportButton.textContent = "正在绘制矢量 PDF…";
      const dimensionLabel = dimensionLabels[dimension] || "分类";
      const metricLabel = rankingMetricLabels[rankingMetric] || "业务";
      const productLabel = productId
        ? state.rankingProducts.find((product) => product.id === productId)?.label || "指定项目"
        : "全部项目";
      window.HqDashboardReport.downloadReport({
        filename: `露思卓儿总部-${range.startDate}至${range.endDate}-${dimensionLabel}-${metricLabel}排名`,
        startDate: range.startDate,
        endDate: range.endDate,
        dimensionLabel,
        metric: rankingMetric,
        metricLabel,
        productLabel,
        generatedAt: new Intl.DateTimeFormat("zh-CN", {
          timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }).format(new Date()),
        productRows,
        totals: state.data.totals,
        rankingRows,
        rankingTotal
      });
    } catch (error) {
      window.alert(error?.message || "总部矢量 PDF 导出失败，请稍后重试");
    } finally {
      state.exporting = false;
      exportButton.textContent = originalLabel;
      setControlsLoading(false);
    }
  }

  function setControlsLoading(loading) {
    dateFilters.forEach((id) => {
      $(id).disabled = loading;
      $(id).syncChineseDate?.();
    });
    $("reset").disabled = loading;
    $("exportBtn").disabled = loading || state.requestState !== "ready" || state.exporting || Boolean(state.ranking?.error);
    $("rankingDimension").disabled = loading || state.requestState !== "ready" || state.rankingLoading || state.exporting;
    document.querySelectorAll("[data-dashboard-dimension], [data-dashboard-metric], #dashboardRankingProduct").forEach((control) => {
      control.disabled = loading || state.requestState !== "ready" || state.rankingLoading || state.exporting;
    });
    document.querySelectorAll("[data-drill]").forEach((button) => {
      button.disabled = loading || state.requestState !== "ready";
    });
    $("dashboardMain").setAttribute("aria-busy", loading ? "true" : "false");
    renderRankingPager();
  }

  function renderRequestState(message, kind) {
    const safeMessage = escapeHtml(message);
    $("rankingBody").innerHTML = `<tr><td colspan="8">${safeMessage}</td></tr>`;
    $("productSummaryBadge").textContent = "共 0 个项目";
    $("productSummaryBody").innerHTML = `<div class="hq-project-summary-empty">${safeMessage}</div>`;
    ["productSummaryRecharge", "productSummaryVerification", "productSummaryExperience", "productSummaryRefund"].forEach((id) => { $(id).textContent = "—"; });
    $("productSummaryPager").hidden = true;
    $("scopeText").textContent = message;
    $("dashboardRetry").hidden = !(kind === "error" && state.retryable);
  }

  function beginRequest() {
    state.requestState = "loading";
    state.requestError = "";
    state.retryable = false;
    state.loadedAt = null;
    state.data = EMPTY_DATA;
    state.ranking = { ...EMPTY_RANKING, dimension: rankingDimension() };
    state.rankingLoading = true;
    state.productSummary = EMPTY_PRODUCT_SUMMARY;
    state.productSummaryLoading = true;
    setControlsLoading(true);
    renderRequestState("正在从数据库读取总部统计数据…", "loading");
  }

  function failRequest(message, retryable) {
    state.requestState = "error";
    state.requestError = message;
    state.retryable = retryable;
    state.loadedAt = null;
    state.data = EMPTY_DATA;
    state.ranking = { ...EMPTY_RANKING, dimension: rankingDimension() };
    state.rankingLoading = false;
    state.productSummary = { ...EMPTY_PRODUCT_SUMMARY, error: message };
    state.productSummaryLoading = false;
    setControlsLoading(false);
    renderRequestState(message, "error");
  }

  async function fetchRankingPage(range, dimension, rankingMetric, productId, pageNumber, pageSize = RANKING_PAGE_SIZE) {
    if (typeof window.CloudBasePhoneAuth?.getHqDashboard !== "function") {
      throw new Error("总部数据库服务未加载，请刷新页面后重试");
    }
    const payload = await window.CloudBasePhoneAuth.getHqDashboard({
      startDate: range.startDate,
      endDate: range.endDate,
      mode: "ranking",
      dimension,
      rankingMetric,
      productId,
      pageNumber,
      pageSize
    });
    return normalizeRanking(payload, dimension);
  }

  async function fetchProductSummaryPage(range, pageNumber, pageSize = PRODUCT_SUMMARY_PAGE_SIZE) {
    if (typeof window.CloudBasePhoneAuth?.getHqDashboard !== "function") {
      throw new Error("总部数据库服务未加载，请刷新页面后重试");
    }
    const payload = await window.CloudBasePhoneAuth.getHqDashboard({
      startDate: range.startDate,
      endDate: range.endDate,
      mode: "product-summary",
      pageNumber,
      pageSize
    });
    return normalizeProductSummary(payload);
  }

  async function loadProductSummaryPage(requestedPage) {
    if (state.requestState !== "ready" || state.productSummaryLoading) return;
    const range = selectedRange();
    if (!range.valid) return;
    const maximum = Math.max(1, Number(state.productSummary?.totalPages || 1));
    const pageNumber = Math.min(maximum, Math.max(1, Number(requestedPage) || 1));
    const sequence = ++state.productSummaryRequestSequence;
    state.productSummaryLoading = true;
    state.productSummary = { ...state.productSummary, rows: [], error: "" };
    renderProductSummary();
    try {
      const summary = await fetchProductSummaryPage(range, pageNumber);
      if (sequence !== state.productSummaryRequestSequence || state.requestState !== "ready") return;
      state.productSummary = summary;
    } catch (error) {
      if (sequence !== state.productSummaryRequestSequence || state.requestState !== "ready") return;
      state.productSummary = {
        ...state.productSummary,
        rows: [],
        error: error?.message || "总部项目汇总读取失败，请稍后重试"
      };
    } finally {
      if (sequence !== state.productSummaryRequestSequence) return;
      state.productSummaryLoading = false;
      renderProductSummary();
    }
  }

  async function loadRankingPage(requestedPage) {
    if (state.requestState !== "ready" || state.rankingLoading || state.exporting) return;
    const range = selectedRange();
    if (!range.valid) return;
    const dimension = rankingDimension();
    const rankingMetric = state.rankingMetric;
    const productId = state.rankingProductId;
    const maximum = Math.max(1, Number(state.ranking?.accessibleTotalPages || state.ranking?.totalPages || 1));
    const pageNumber = Math.min(maximum, Math.max(1, Number(requestedPage) || 1));
    const sequence = ++state.rankingRequestSequence;
    state.rankingLoading = true;
    $("rankingDimension").disabled = true;
    $("exportBtn").disabled = true;
    renderRankingPager();
    try {
      const ranking = await fetchRankingPage(range, dimension, rankingMetric, productId, pageNumber);
      if (sequence !== state.rankingRequestSequence || state.requestState !== "ready") return;
      if (ranking.dimension !== dimension || ranking.rankingMetric !== rankingMetric || ranking.productId !== productId) {
        throw new Error("总部排名返回范围与当前选择不一致");
      }
      state.ranking = ranking;
    } catch (error) {
      if (sequence !== state.rankingRequestSequence || state.requestState !== "ready") return;
      state.ranking = {
        ...state.ranking,
        dimension,
        rankingMetric,
        productId,
        error: error?.message || "总部排名读取失败，请稍后重试"
      };
    } finally {
      if (sequence !== state.rankingRequestSequence) return;
      state.rankingLoading = false;
      $("rankingDimension").disabled = state.requestState !== "ready" || state.exporting;
      $("exportBtn").disabled = state.requestState !== "ready" || state.exporting || Boolean(state.ranking?.error);
      if (pageNumber === 1) {
        const { rows, teacherRows } = currentData();
        renderAnalysis(rows, teacherRows);
      }
      renderRanking();
    }
  }

  function jumpToRankingPage() {
    const input = $("rankingPageInput");
    const raw = String(input?.value || "").trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
      input.setCustomValidity("请输入有效的正整数页码");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    const maximum = Math.max(1, Number(state.ranking?.accessibleTotalPages || state.ranking?.totalPages || 1));
    void loadRankingPage(Math.min(Number(raw), maximum));
  }

  async function loadDashboard() {
    const range = selectedRange();
    if (!range.valid) {
      state.requestSequence += 1;
      failRequest(range.message, false);
      return;
    }

    const sequence = ++state.requestSequence;
    state.rankingRequestSequence += 1;
    state.productSummaryRequestSequence += 1;
    beginRequest();
    try {
      if (typeof window.CloudBasePhoneAuth?.getHqDashboard !== "function") {
        throw new Error("总部数据库服务未加载，请刷新页面后重试");
      }
      const dimension = rankingDimension();
      const rankingMetric = state.rankingMetric;
      const productId = state.rankingProductId;
      const [overviewResult, rankingResult, productsResult, productSummaryResult] = await Promise.allSettled([
        window.CloudBasePhoneAuth.getHqDashboard({
          startDate: range.startDate,
          endDate: range.endDate,
          mode: "overview"
        }),
        window.CloudBasePhoneAuth.getHqDashboard({
          startDate: range.startDate,
          endDate: range.endDate,
          mode: "ranking",
          dimension,
          rankingMetric,
          productId,
          pageNumber: 1,
          pageSize: RANKING_PAGE_SIZE
        }),
        window.CloudBasePhoneAuth.listProducts(),
        window.CloudBasePhoneAuth.getHqDashboard({
          startDate: range.startDate,
          endDate: range.endDate,
          mode: "product-summary",
          pageNumber: 1,
          pageSize: PRODUCT_SUMMARY_PAGE_SIZE
        })
      ]);
      if (sequence !== state.requestSequence) return;
      if (overviewResult.status !== "fulfilled") throw overviewResult.reason;
      const data = normalizeDashboard(overviewResult.value, range);
      state.data = data;
      if (productsResult.status === "fulfilled") {
        state.rankingProducts = (productsResult.value || []).map((product) => ({
          id: String(product.id || ""),
          label: `${String(product.product_name || product.productName || "未命名项目")}${product.product_code ? ` · ${product.product_code}` : ""}${String(product.product_status || "").toUpperCase() === "ARCHIVED" ? "（已封存）" : ""}`
        })).filter((product) => product.id);
        if (state.rankingProductId && !state.rankingProducts.some((product) => product.id === state.rankingProductId)) {
          state.rankingProductId = "";
        }
      }
      if (rankingResult.status === "fulfilled") {
        try {
          state.ranking = normalizeRanking(rankingResult.value, dimension);
          if (state.ranking.rankingMetric !== rankingMetric || state.ranking.productId !== productId) {
            throw new Error("总部排名返回范围与当前选择不一致");
          }
        } catch (rankingError) {
          state.ranking = {
            ...EMPTY_RANKING,
            dimension,
            error: rankingError?.message || "总部排名返回格式无效，请单独重试"
          };
        }
      } else {
        state.ranking = {
          ...EMPTY_RANKING,
          dimension,
          error: rankingResult.reason?.message || "总部排名读取失败，请单独重试"
        };
      }
      if (productSummaryResult.status === "fulfilled") {
        try {
          state.productSummary = normalizeProductSummary(productSummaryResult.value);
        } catch (summaryError) {
          state.productSummary = {
            ...EMPTY_PRODUCT_SUMMARY,
            error: summaryError?.message || "总部项目汇总返回格式无效"
          };
        }
      } else {
        state.productSummary = {
          ...EMPTY_PRODUCT_SUMMARY,
          error: productSummaryResult.reason?.message || "总部项目汇总读取失败"
        };
      }
      state.rankingLoading = false;
      state.productSummaryLoading = false;
      state.range = data.range;
      state.loadedAt = new Date();
      state.requestState = "ready";
      state.requestError = "";
      state.retryable = false;
      resetBreakdowns();
      setControlsLoading(false);
      $("dashboardRetry").hidden = true;
      render();
    } catch (error) {
      if (sequence !== state.requestSequence) return;
      failRequest(error?.message || "总部首页数据库统计读取失败，请稍后重试", true);
    }
  }

  function init() {
    document.documentElement.dataset.prototypeVersion = PROTOTYPE_VERSION;
    setPeriodDates("today");
    toggleDashboardDateFields();
    dateFilters.forEach((id) => $(id).addEventListener("change", () => {
      if (id === "period" && $("period").value !== "custom") {
        setPeriodDates($("period").value);
      } else if (id === "dateFrom" || id === "dateTo") {
        $("period").value = "custom";
      }
      toggleDashboardDateFields();
      void loadDashboard();
    }));
    $("reset").addEventListener("click", () => {
      ["store", "project", "teacher"].forEach((id) => $(id).value = "all");
      $("period").value = "today";
      $("limit").value = "10";
      $("search").value = "";
      $("rankingDimension").value = "store";
      state.rankingMetric = "recharge";
      state.rankingProductId = "";
      setPeriodDates("today");
      toggleDashboardDateFields();
      void loadDashboard();
    });
    $("dashboardRetry").addEventListener("click", () => { void loadDashboard(); });
    $("productSummaryPrevious").addEventListener("click", () => {
      void loadProductSummaryPage(Math.max(1, Number(state.productSummary.pageNumber || 1) - 1));
    });
    $("productSummaryNext").addEventListener("click", () => {
      void loadProductSummaryPage(Math.min(Number(state.productSummary.totalPages || 1), Number(state.productSummary.pageNumber || 1) + 1));
    });
    $("exportBtn").addEventListener("click", exportPdf);
    if ($("rankingDimension")) $("rankingDimension").addEventListener("change", () => {
      if (state.requestState !== "ready") return;
      const { rows, teacherRows } = currentData();
      renderAnalysis(rows, teacherRows);
      void loadRankingPage(1);
    });
    $("rankingPreviousPage")?.addEventListener("click", () => {
      void loadRankingPage(Math.max(1, Number(state.ranking?.pageNumber || 1) - 1));
    });
    $("rankingNextPage")?.addEventListener("click", () => {
      void loadRankingPage(Math.min(
        Math.max(1, Number(state.ranking?.accessibleTotalPages || state.ranking?.totalPages || 1)),
        Number(state.ranking?.pageNumber || 1) + 1
      ));
    });
    $("rankingPageJump")?.addEventListener("click", jumpToRankingPage);
    $("rankingRetry")?.addEventListener("click", () => {
      void loadRankingPage(Math.max(1, Number(state.ranking?.pageNumber || 1)));
    });
    $("rankingPageInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        jumpToRankingPage();
      }
    });
    $("closeDialog").addEventListener("click", () => $("detailDialog").close());
    document.addEventListener("click", (event) => {
      const card = event.target.closest("[data-drill]");
      const point = event.target.closest("[data-name]");
      const dimensionButton = event.target.closest("[data-dashboard-dimension]");
      const metricButton = event.target.closest("[data-dashboard-metric]");
      if (state.requestState !== "ready") return;
      if ((dimensionButton || metricButton) && (state.rankingLoading || state.exporting)) return;
      if (card) {
        openDashboardQuery(card.dataset.drill || "recharge");
      } else if (dimensionButton) {
        const dimension = dimensionButton.dataset.dashboardDimension;
        if (!["store", "teacher"].includes(dimension) || dimension === rankingDimension()) return;
        $("rankingDimension").value = dimension;
        void loadRankingPage(1);
      } else if (metricButton) {
        const rankingMetric = metricButton.dataset.dashboardMetric;
        if (!Object.prototype.hasOwnProperty.call(rankingMetricLabels, rankingMetric) || rankingMetric === state.rankingMetric) return;
        state.rankingMetric = rankingMetric;
        void loadRankingPage(1);
      }
      else if (point) showDetail(`${point.dataset.name} 的有效明细`);
    });
    document.addEventListener("change", (event) => {
      if (event.target?.id !== "dashboardRankingProduct" || state.requestState !== "ready" || state.rankingLoading || state.exporting) return;
      const productId = String(event.target.value || "");
      if (productId === state.rankingProductId) return;
      state.rankingProductId = productId;
      void loadRankingPage(1);
    });
    resetBreakdowns();
    void loadDashboard();
  }

  init();
})();

(() => {
  "use strict";

  // 文档同步约束：每次业务或界面变更都必须同步更新 main.tex 与 README.md。
  const PROTOTYPE_VERSION = "0.15.5";
  const BUSINESS_TIME_ZONE = "Asia/Shanghai";
  const RANKING_PAGE_SIZE = 100;
  const RANKING_MAX_PAGE_NUMBER = 10000;
  const CSV_EXPORT_PAGE_SIZE = 500;
  const CSV_EXPORT_MAX_ROWS = 10000;
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
    pageNumber: 1,
    pageSize: RANKING_PAGE_SIZE,
    total: 0,
    totalPages: 1,
    accessibleTotalPages: 1,
    businessTotal: 0,
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
    exporting: false
  };
  const dimensionLabels = { store: "门店", project: "项目", teacher: "老师" };
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

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
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
      pageNumber: Math.min(accessibleTotalPages, Math.max(1, finiteCount(pick(source, "pageNumber", "page_number"), 1))),
      pageSize,
      total,
      totalPages,
      accessibleTotalPages,
      businessTotal: finiteCount(pick(source, "businessTotal", "business_total"), 0),
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
    if (period === "thisWeek") {
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

  function aggregate(rows, key) {
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
    return [...map.values()].sort((a, b) =>
      (b.recharge + b.verification + b.experience + b.refund) - (a.recharge + a.verification + a.experience + a.refund)
    );
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

  function renderMetrics(rows, teacherRows) {
    const totals = state.data.totals || {};
    const derivedRecharge = rows.reduce((sum, row) => sum + row.recharge, 0);
    const derivedVerification = rows.reduce((sum, row) => sum + row.verification, 0);
    const derivedExperience = rows.reduce((sum, row) => sum + row.experience, 0);
    const derivedRefund = rows.reduce((sum, row) => sum + row.refund, 0);
    const recharge = finiteNumber(totals.recharge, derivedRecharge);
    const verification = finiteCount(totals.verification, derivedVerification);
    const experience = finiteCount(totals.experience, derivedExperience);
    const refund = finiteCount(totals.refund, derivedRefund);
    const stores = finiteCount(totals.stores, new Set(rows.map((row) => row.storeId).filter(Boolean)).size);
    const teachers = finiteCount(totals.teachers, new Set(teacherRows.map((row) => row.teacherId).filter(Boolean)).size);
    $("rechargeTotal").textContent = fmt.format(recharge);
    $("verificationTotal").textContent = fmt.format(verification);
    $("experienceTotal").textContent = fmt.format(experience);
    $("refundTotal").textContent = fmt.format(refund);
    $("rechargeDelta").textContent = "数据库有效记录";
    $("verificationDelta").textContent = "数据库有效记录";
    $("experienceDelta").textContent = "数据库有效记录";
    $("refundDelta").textContent = "数据库有效记录";
    $("storeTotal").textContent = fmt.format(stores);
    $("teacherTotal").textContent = fmt.format(teachers);
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

  function barChartMarkup(sourceRows, dimension) {
    const items = limited(aggregate(sourceRows, dimension));
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
    return `<div class="bar-scroll"><div class="chart-legend">${legend}<span>纵轴：次数 · 间隔 ${fmt.format(axis.step)}</span></div><div class="bar-chart-body"><div class="bar-y-axis"><strong>次数</strong>${tickMarkup}</div><div class="bar-plot-scroll"><div class="bar-canvas" aria-label="纵轴从${axis.min}到${axis.max}次，每${axis.step}次一个刻度">${gridMarkup}${barsMarkup}</div></div></div></div>`;
  }

  function renderAnalysis(rows, teacherRows) {
    const selected = selectedDimensions();
    const dimensions = selected.length ? [...state.breakdowns] : (state.view === "global" ? ["store", "project", "teacher"] : []);
    if (!dimensions.length) {
      const message = selected.length ? "已定位到具体门店、项目和老师，请查看指标卡、排名和明细" : "请先从上方下拉框选择一个门店、项目或业务老师";
      $("analysisGrid").innerHTML = `<article class="panel chart-card"><div class="empty-state">${message}</div></article>`;
      return;
    }
    const scopeName = escapeHtml(selected.length ? selected.map((key) => $(key).selectedOptions[0].text).join(" · ") : "全局");
    $("analysisGrid").innerHTML = dimensions.map((dimension) => {
      const isTeacher = dimension === "teacher";
      const teacherContext = isTeacher || selected.includes("teacher");
      const source = dimension === "store" && !selected.length && state.data.stores.length
        ? state.data.stores
        : teacherContext ? teacherRows : rows;
      return `<article class="panel chart-card"><div class="panel-heading"><div><h2>${scopeName} · 按${dimensionLabels[dimension]}统计</h2><p>有效充值、核销、体验与退费次数 · 图内横向滚动</p></div><span class="badge">${dimensionLabels[dimension]}</span></div>${barChartMarkup(source, dimension)}</article>`;
    }).join("");
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
    if (ranking.error) {
      $("rankingBody").innerHTML = `<tr><td colspan="8">${escapeHtml(ranking.error)}</td></tr>`;
      renderRankingPager();
      return;
    }
    const total = Math.max(1, Number(ranking.businessTotal || 0));
    const pageOffset = (Math.max(1, Number(ranking.pageNumber || 1)) - 1) * Math.max(1, Number(ranking.pageSize || RANKING_PAGE_SIZE));
    $("rankingBody").innerHTML = ranking.rows.map((row, index) => {
      const safeName = escapeHtml(row.name);
      const businessCount = row.recharge + row.verification + row.experience + row.refund;
      return `<tr data-name="${safeName}"><td>${fmt.format(pageOffset + index + 1)}</td><td>${safeName}</td><td>按${dimensionLabels[dimension]}</td><td>${fmt.format(row.recharge)}</td><td>${fmt.format(row.verification)}</td><td>${fmt.format(row.experience)}</td><td>${fmt.format(row.refund)}</td><td>${(businessCount / total * 100).toFixed(1)}%</td></tr>`;
    }).join("") || `<tr><td colspan="8">当前日期范围暂无有效数据</td></tr>`;
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
    renderMetrics(rows, teacherRows);
    renderAnalysis(rows, teacherRows);
    renderRanking(rows, teacherRows);
    renderScope();
  }

  function showDetail(type) {
    $("detailText").textContent = `${type}；${$("scopeText").textContent}`;
    $("detailDialog").showModal();
  }

  function rankingCsvHeader(dimension) {
    const label = dimensionLabels[dimension] || "分类对象";
    return [`${label}编号`, label, "有效充值次数", "有效核销次数", "有效体验次数", "有效退费次数"];
  }

  function rankingCsvRow(row) {
    return [row.entityId, row.name, row.recharge, row.verification, row.experience, row.refund];
  }

  async function exportCsv() {
    if (state.requestState !== "ready" || state.exporting) return;
    const range = selectedRange();
    if (!range.valid) return;
    const dimension = rankingDimension();
    const currentRanking = state.ranking || EMPTY_RANKING;
    if (currentRanking.error) {
      window.alert("排名尚未读取成功，暂时不能导出。请先重试排名读取。");
      return;
    }
    if (Number(currentRanking.total || 0) > CSV_EXPORT_MAX_ROWS) {
      window.alert(`当前${dimensionLabels[dimension] || "分类"}排名共有 ${fmt.format(currentRanking.total)} 条。为避免浏览器内存占用，单次 CSV 最多导出 ${fmt.format(CSV_EXPORT_MAX_ROWS)} 条；请缩小统计日期范围后重试。`);
      return;
    }
    const exportButton = $("exportBtn");
    const originalLabel = exportButton.textContent;
    state.exporting = true;
    setControlsLoading(true);
    try {
      const values = [rankingCsvHeader(dimension)];
      let pageNumber = 1;
      let totalPages = 1;
      do {
        exportButton.textContent = `正在导出第 ${pageNumber} / ${totalPages} 页…`;
        const payload = await window.CloudBasePhoneAuth.getHqDashboard({
          startDate: range.startDate,
          endDate: range.endDate,
          mode: "ranking",
          dimension,
          pageNumber,
          pageSize: CSV_EXPORT_PAGE_SIZE
        });
        const page = normalizeRanking(payload, dimension);
        if (page.dimension !== dimension) throw new Error("总部排名导出维度与当前选择不一致");
        if (page.total > CSV_EXPORT_MAX_ROWS) {
          throw new Error(`当前${dimensionLabels[dimension] || "分类"}排名共有 ${fmt.format(page.total)} 条。为避免浏览器内存占用，单次 CSV 最多导出 ${fmt.format(CSV_EXPORT_MAX_ROWS)} 条；请缩小统计日期范围后重试。`);
        }
        if (values.length - 1 + page.rows.length > CSV_EXPORT_MAX_ROWS) {
          throw new Error(`单次 CSV 最多导出 ${fmt.format(CSV_EXPORT_MAX_ROWS)} 条，已停止继续读取。请缩小统计日期范围后重试。`);
        }
        totalPages = page.totalPages;
        values.push(...page.rows.map(rankingCsvRow));
        pageNumber += 1;
      } while (pageNumber <= totalPages);
      const csv = values.map((row) => row.map(csvCell).join(",")).join("\r\n");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
      link.download = `总部看板${dimensionLabels[dimension] || "分类"}排名.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
    } catch (error) {
      window.alert(error?.message || "总部排名导出失败，请稍后重试");
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
    document.querySelectorAll("[data-drill]").forEach((button) => {
      button.disabled = loading || state.requestState !== "ready";
    });
    $("dashboardMain").setAttribute("aria-busy", loading ? "true" : "false");
    renderRankingPager();
  }

  function renderRequestState(message, kind) {
    const safeMessage = escapeHtml(message);
    ["rechargeTotal", "verificationTotal", "experienceTotal", "refundTotal", "storeTotal", "teacherTotal"].forEach((id) => { $(id).textContent = "—"; });
    $("rechargeDelta").textContent = kind === "loading" ? "正在读取数据库" : "数据库读取失败";
    $("verificationDelta").textContent = kind === "loading" ? "正在读取数据库" : "数据库读取失败";
    $("experienceDelta").textContent = kind === "loading" ? "正在读取数据库" : "数据库读取失败";
    $("refundDelta").textContent = kind === "loading" ? "正在读取数据库" : "数据库读取失败";
    $("analysisGrid").innerHTML = `<article class="panel chart-card dashboard-request-state ${kind}"><div class="empty-state">${safeMessage}</div></article>`;
    $("rankingBody").innerHTML = `<tr><td colspan="8">${safeMessage}</td></tr>`;
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
    setControlsLoading(false);
    renderRequestState(message, "error");
  }

  async function fetchRankingPage(range, dimension, pageNumber, pageSize = RANKING_PAGE_SIZE) {
    if (typeof window.CloudBasePhoneAuth?.getHqDashboard !== "function") {
      throw new Error("总部数据库服务未加载，请刷新页面后重试");
    }
    const payload = await window.CloudBasePhoneAuth.getHqDashboard({
      startDate: range.startDate,
      endDate: range.endDate,
      mode: "ranking",
      dimension,
      pageNumber,
      pageSize
    });
    return normalizeRanking(payload, dimension);
  }

  async function loadRankingPage(requestedPage) {
    if (state.requestState !== "ready" || state.rankingLoading || state.exporting) return;
    const range = selectedRange();
    if (!range.valid) return;
    const dimension = rankingDimension();
    const maximum = Math.max(1, Number(state.ranking?.accessibleTotalPages || state.ranking?.totalPages || 1));
    const pageNumber = Math.min(maximum, Math.max(1, Number(requestedPage) || 1));
    const sequence = ++state.rankingRequestSequence;
    state.rankingLoading = true;
    $("rankingDimension").disabled = true;
    $("exportBtn").disabled = true;
    renderRankingPager();
    try {
      const ranking = await fetchRankingPage(range, dimension, pageNumber);
      if (sequence !== state.rankingRequestSequence || state.requestState !== "ready") return;
      state.ranking = ranking;
    } catch (error) {
      if (sequence !== state.rankingRequestSequence || state.requestState !== "ready") return;
      state.ranking = {
        ...state.ranking,
        dimension,
        error: error?.message || "总部排名读取失败，请稍后重试"
      };
    } finally {
      if (sequence !== state.rankingRequestSequence) return;
      state.rankingLoading = false;
      $("rankingDimension").disabled = state.requestState !== "ready" || state.exporting;
      $("exportBtn").disabled = state.requestState !== "ready" || state.exporting || Boolean(state.ranking?.error);
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
    beginRequest();
    try {
      if (typeof window.CloudBasePhoneAuth?.getHqDashboard !== "function") {
        throw new Error("总部数据库服务未加载，请刷新页面后重试");
      }
      const dimension = rankingDimension();
      const [overviewResult, rankingResult] = await Promise.allSettled([
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
          pageNumber: 1,
          pageSize: RANKING_PAGE_SIZE
        })
      ]);
      if (sequence !== state.requestSequence) return;
      if (overviewResult.status !== "fulfilled") throw overviewResult.reason;
      const data = normalizeDashboard(overviewResult.value, range);
      state.data = data;
      if (rankingResult.status === "fulfilled") {
        try {
          state.ranking = normalizeRanking(rankingResult.value, dimension);
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
      state.rankingLoading = false;
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
    setPeriodDates("last30");
    dateFilters.forEach((id) => $(id).addEventListener("change", () => {
      if (id === "period" && $("period").value !== "custom") {
        setPeriodDates($("period").value);
      } else if (id === "dateFrom" || id === "dateTo") {
        $("period").value = "custom";
      }
      void loadDashboard();
    }));
    $("reset").addEventListener("click", () => {
      ["store", "project", "teacher"].forEach((id) => $(id).value = "all");
      $("period").value = "last30";
      $("limit").value = "10";
      $("search").value = "";
      setPeriodDates("last30");
      void loadDashboard();
    });
    $("dashboardRetry").addEventListener("click", () => { void loadDashboard(); });
    $("exportBtn").addEventListener("click", exportCsv);
    if ($("rankingDimension")) $("rankingDimension").addEventListener("change", () => {
      if (state.requestState !== "ready") return;
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
      if (state.requestState !== "ready") return;
      if (card) {
        const labels = {
          recharge: "有效充值明细",
          verification: "有效核销明细",
          experience: "有效体验明细",
          refund: "有效退费明细"
        };
        showDetail(labels[card.dataset.drill] || "有效业务明细");
      }
      else if (point) showDetail(`${point.dataset.name} 的有效明细`);
    });
    resetBreakdowns();
    void loadDashboard();
  }

  init();
})();

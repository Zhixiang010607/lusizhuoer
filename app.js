(() => {
  "use strict";

  // 文档同步约束：每次业务或界面变更都必须同步更新 main.tex 与 README.md。
  const PROTOTYPE_VERSION = "0.14.19";

  // Start with an empty dataset. Real dashboard data is supplied by the backend later.
  class EmptyDataSource {
    async load() {
      return { stores: [], teachers: [], projects: [], rows: [], teacherRows: [] };
    }
  }

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("zh-CN");
  const state = { data: null, breakdowns: new Set(), view: document.body.dataset.view || "global" };
  const dimensionLabels = { store: "门店", project: "项目", teacher: "老师" };
  const filters = ["period", "dateFrom", "dateTo", "store", "project", "teacher", "limit", "search"];

  function toDateInput(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function setPeriodDates(period) {
    const today = new Date();
    const year = today.getFullYear();
    let start;
    let end = new Date(today);
    if (period === "thisWeek") {
      const weekday = today.getDay() || 7;
      start = new Date(today);
      start.setDate(today.getDate() - weekday + 1);
    } else if (period === "thisMonth") {
      start = new Date(year, today.getMonth(), 1);
    } else if (period === "last7" || period === "last30") {
      const days = period === "last7" ? 7 : 30;
      start = new Date(today);
      start.setDate(today.getDate() - days + 1);
    } else if (period === "ytd") {
      start = new Date(year, 0, 1);
    } else if (/^q[1-4]$/.test(period)) {
      const quarter = Number(period.slice(1));
      start = new Date(year, (quarter - 1) * 3, 1);
      const naturalEnd = new Date(year, quarter * 3, 0);
      end = start > today ? naturalEnd : new Date(Math.min(naturalEnd.getTime(), today.getTime()));
    } else {
      return;
    }
    $("dateFrom").value = toDateInput(start);
    $("dateTo").value = toDateInput(end);
  }

  function selectedRange() {
    const start = new Date(`${$("dateFrom").value}T00:00:00`);
    const selectedEnd = new Date(`${$("dateTo").value}T23:59:59`);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(selectedEnd.getTime()) || start > today) {
      return { days: 0, isFuture: true };
    }
    const end = new Date(Math.min(selectedEnd.getTime(), today.getTime()));
    const days = Math.max(0, Math.floor((end - start) / 86400000) + 1);
    return { days, isFuture: false };
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
    const range = selectedRange();
    const factor = Math.min(range.days / 365, 1);
    const rows = state.data.rows.filter((r) =>
      (storeId === "all" || r.storeId === storeId) &&
      (project === "all" || r.project === project) &&
      (!q || `${r.store} ${r.storeId} ${r.project}`.toLowerCase().includes(q))
    ).map((r) => ({ ...r, recharge: Math.round(r.recharge * factor), verification: Math.round(r.verification * factor) }));
    const teacherRows = state.data.teacherRows.filter((r) =>
      (storeId === "all" || r.storeId === storeId) &&
      (teacherId === "all" || r.teacherId === teacherId) &&
      (project === "all" || r.project === project) &&
      (!q || `${r.store} ${r.storeId} ${r.teacher} ${r.teacherId} ${r.project}`.toLowerCase().includes(q))
    ).map((r) => ({ ...r, recharge: Math.round(r.recharge * factor), verification: Math.round(r.verification * factor) }));
    const localViewNeedsObject = state.view === "local" && selectedDimensions().length === 0;
    return { rows: range.isFuture || localViewNeedsObject ? [] : rows, teacherRows: range.isFuture || localViewNeedsObject ? [] : teacherRows };
  }

  function aggregate(rows, key) {
    const map = new Map();
    rows.forEach((r) => {
      const name = r[key];
      const item = map.get(name) || { name, recharge: 0, verification: 0 };
      item.recharge += r.recharge || 0;
      item.verification += r.verification || 0;
      map.set(name, item);
    });
    return [...map.values()].sort((a, b) => b.verification - a.verification);
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
    const teacherSelected = $("teacher").value !== "all";
    const metricRows = teacherSelected ? teacherRows : rows;
    const recharge = metricRows.reduce((s, r) => s + r.recharge, 0);
    const verification = metricRows.reduce((s, r) => s + r.verification, 0);
    $("rechargeTotal").textContent = fmt.format(recharge);
    $("verificationTotal").textContent = fmt.format(verification);
    $("rechargeDelta").textContent = `较上一周期 +${(3.2 + rows.length % 7).toFixed(1)}%`;
    $("verificationDelta").textContent = `较上一周期 +${(1.8 + teacherRows.length % 5).toFixed(1)}%`;
    $("storeTotal").textContent = new Set(metricRows.map((r) => r.storeId)).size;
    $("teacherTotal").textContent = new Set(teacherRows.map((r) => r.teacherId)).size;
  }

  function renderTrend(rows, teacherRows) {
    if (!$("trendChart")) return;
    const trendRows = $("teacher").value !== "all" ? teacherRows : rows;
    if (!trendRows.length) {
      $("trendChart").innerHTML = `<div class="empty-state">所选时间周期暂无有效充值或核销数据</div>`;
      return;
    }
    const days = Math.max(1, Math.min(selectedRange().days, 45));
    const totalR = trendRows.reduce((s, r) => s + r.recharge, 0);
    const totalV = trendRows.reduce((s, r) => s + r.verification, 0);
    const pointsR = Array.from({ length: days }, (_, i) => 35 + (Math.sin(i * .65) + 1.3) * totalR / Math.max(days, 1) / 2.9 + (i % 5) * 3);
    const pointsV = Array.from({ length: days }, (_, i) => 30 + (Math.cos(i * .55) + 1.4) * totalV / Math.max(days, 1) / 2.6 + (i % 4) * 2);
    const max = Math.max(...pointsR, ...pointsV, 1);
    const path = (values) => values.map((v, i) => `${i ? "L" : "M"}${45 + i * (810 / Math.max(values.length - 1, 1))},${225 - v / max * 180}`).join(" ");
    const grid = [0, 1, 2, 3, 4].map((i) => `<line class="grid-line" x1="45" y1="${45 + i * 45}" x2="855" y2="${45 + i * 45}"/>`).join("");
    $("trendChart").innerHTML = `<div class="chart-legend"><span><i class="legend-dot" style="background:#1f5eff"></i>有效充值</span><span><i class="legend-dot" style="background:#00a884"></i>有效核销</span></div><svg class="trend-svg" viewBox="0 0 900 260" preserveAspectRatio="none">${grid}<path class="trend-recharge" d="${path(pointsR)}"/><path class="trend-verification" d="${path(pointsV)}"/><text class="axis-text" x="45" y="250">${$("dateFrom").value}</text><text class="axis-text" x="790" y="250">${$("dateTo").value}</text></svg>`;
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

  function barChartMarkup(sourceRows, dimension, verificationOnly = false) {
    const items = limited(aggregate(sourceRows, dimension));
    if (!items.length) return `<div class="empty-state">当前筛选与分类范围内暂无有效数据</div>`;
    const series = verificationOnly ? ["verification"] : ["recharge", "verification"];
    const largestValue = Math.max(...items.flatMap((x) => series.map((key) => x[key])), 0);
    const axis = flexibleAxis(largestValue);
    const tickMarkup = axis.ticks.map((tick) => {
      const top = 20 + (1 - tick / axis.max) * 240;
      return `<span class="bar-axis-tick" style="top:${top}px">${fmt.format(tick)}</span>`;
    }).join("");
    const gridMarkup = axis.ticks.map((tick) => {
      const top = 20 + (1 - tick / axis.max) * 240;
      return `<i class="bar-grid-line" style="top:${top}px"></i>`;
    }).join("");
    const barsMarkup = items.map((x) => `<button class="bar-group" data-name="${x.name}" title="${x.name}：${verificationOnly ? `核销 ${x.verification}` : `充值 ${x.recharge}，核销 ${x.verification}`}"><span class="bars ${verificationOnly ? "single" : ""}">${series.map((key) => `<i class="bar ${key}" style="height:${x[key] / axis.max * 100}%"></i>`).join("")}</span><span class="bar-label">${x.name}</span></button>`).join("");
    const legend = verificationOnly ? `<span><i class="legend-dot" style="background:#00a884"></i>有效核销</span>` : `<span><i class="legend-dot" style="background:#1f5eff"></i>有效充值</span><span><i class="legend-dot" style="background:#00a884"></i>有效核销</span>`;
    return `<div class="bar-scroll"><div class="chart-legend">${legend}<span>纵轴：次数 · 间隔 ${fmt.format(axis.step)}</span></div><div class="bar-chart-body"><div class="bar-y-axis"><strong>次数</strong>${tickMarkup}</div><div class="bar-plot-scroll"><div class="bar-canvas" aria-label="纵轴从0到${axis.max}次，每${axis.step}次一个刻度">${gridMarkup}${barsMarkup}</div></div></div></div>`;
  }

  function renderAnalysis(rows, teacherRows) {
    const selected = selectedDimensions();
    const dimensions = selected.length ? [...state.breakdowns] : (state.view === "global" ? ["store", "project", "teacher"] : []);
    if (!dimensions.length) {
      const message = selected.length ? "已定位到具体门店、项目和老师，请查看指标卡、排名和明细" : "请先从上方下拉框选择一个门店、项目或业务老师";
      $("analysisGrid").innerHTML = `<article class="panel chart-card"><div class="empty-state">${message}</div></article>`;
      return;
    }
    const scopeName = selected.length ? selected.map((key) => $(key).selectedOptions[0].text).join(" · ") : "全局";
    $("analysisGrid").innerHTML = dimensions.map((dimension) => {
      const isTeacher = dimension === "teacher";
      const teacherContext = isTeacher || selected.includes("teacher");
      const source = teacherContext ? teacherRows : rows;
      return `<article class="panel chart-card"><div class="panel-heading"><div><h2>${scopeName} · 按${dimensionLabels[dimension]}统计</h2><p>${teacherContext ? "有效核销次数" : "有效充值与有效核销次数"} · 图内横向滚动</p></div><span class="badge">${dimensionLabels[dimension]}</span></div>${barChartMarkup(source, dimension, teacherContext)}</article>`;
    }).join("");
  }

  function rankingDimension() {
    const selector = $("rankingDimension");
    if (selector) return selector.value;
    const selected = selectedDimensions();
    return selected.length ? ([...state.breakdowns][0] || selected[0]) : "store";
  }

  function renderRanking(rows, teacherRows) {
    const dimension = rankingDimension();
    const teacherContext = dimension === "teacher" || selectedDimensions().includes("teacher");
    const items = limited(aggregate(teacherContext ? teacherRows : rows, dimension));
    const total = items.reduce((s, x) => s + x.verification, 0) || 1;
    $("rankingBody").innerHTML = items.map((x, i) => `<tr data-name="${x.name}"><td>${i + 1}</td><td>${x.name}</td><td>按${dimensionLabels[dimension]}</td><td>${teacherContext ? "—" : fmt.format(x.recharge)}</td><td>${fmt.format(x.verification)}</td><td>${(x.verification / total * 100).toFixed(1)}%</td></tr>`).join("") || `<tr><td colspan="6">没有符合条件的数据</td></tr>`;
  }

  function renderScope() {
    const text = `${$("dateFrom").value} 至 ${$("dateTo").value} · ${$("store").selectedOptions[0].text} · ${$("project").selectedOptions[0].text} · ${$("teacher").selectedOptions[0].text}`;
    $("scopeText").textContent = `当前统计范围：${text}；客户范围：全部客户（含活跃及已存档）`;
  }

  function render() {
    const { rows, teacherRows } = currentData();
    renderBreakdownControls();
    renderMetrics(rows, teacherRows);
    renderTrend(rows, teacherRows);
    renderAnalysis(rows, teacherRows);
    renderRanking(rows, teacherRows);
    renderScope();
  }

  function showDetail(type) {
    $("detailText").textContent = `${type}；${$("scopeText").textContent}`;
    $("detailDialog").showModal();
  }

  function exportCsv() {
    const { rows, teacherRows } = currentData();
    const teacherContext = rankingDimension() === "teacher" || selectedDimensions().includes("teacher");
    const csv = teacherContext
      ? ["门店编号,门店,老师编号,老师,项目,有效充值次数,有效核销次数", ...teacherRows.map((r) => [r.storeId, r.store, r.teacherId, r.teacher, r.project, r.recharge, r.verification].join(","))].join("\n")
      : ["门店编号,门店,项目,有效充值次数,有效核销次数", ...rows.map((r) => [r.storeId, r.store, r.project, r.recharge, r.verification].join(","))].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    link.download = "总部看板当前筛选数据.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function init() {
    document.documentElement.dataset.prototypeVersion = PROTOTYPE_VERSION;
    state.data = await new EmptyDataSource().load();
    fillSelect("store", state.data.stores, "id", "name");
    fillSelect("project", state.data.projects);
    fillSelect("teacher", state.data.teachers, "id", "name");
    setPeriodDates("last30");
    filters.forEach((id) => $(id).addEventListener(id === "search" ? "input" : "change", () => {
      if (id === "period" && $("period").value !== "custom") setPeriodDates($("period").value);
      if (id === "dateFrom" || id === "dateTo") $("period").value = "custom";
      if (["store", "project", "teacher"].includes(id)) resetBreakdowns();
      render();
    }));
    $("reset").addEventListener("click", () => {
      ["store", "project", "teacher"].forEach((id) => $(id).value = "all");
      $("period").value = "last30"; $("limit").value = "10"; $("search").value = ""; setPeriodDates("last30"); resetBreakdowns(); render();
    });
    $("exportBtn").addEventListener("click", exportCsv);
    if ($("rankingDimension")) $("rankingDimension").addEventListener("change", () => {
      const { rows, teacherRows } = currentData();
      renderRanking(rows, teacherRows);
    });
    $("closeDialog").addEventListener("click", () => $("detailDialog").close());
    document.addEventListener("click", (event) => {
      const card = event.target.closest("[data-drill]");
      const point = event.target.closest("[data-name]");
      if (card) showDetail(card.dataset.drill === "recharge" ? "有效充值明细" : "有效核销明细");
      else if (point) showDetail(`${point.dataset.name} 的有效明细`);
    });
    resetBreakdowns();
    render();
  }

  init();
})();

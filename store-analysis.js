(() => {
  "use strict";

  const VERSION = "0.1.1";
  const metrics = Object.freeze({ recharge: "充值", verification: "核销", experience: "体验", refund: "退费" });
  const params = new URLSearchParams(location.search);
  const metric = Object.prototype.hasOwnProperty.call(metrics, params.get("metric")) ? params.get("metric") : "recharge";
  const state = { storeId: String(params.get("storeId") || "").trim(), data: null, loading: false };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

  function currentQuery(metricKey = metric) {
    return new URLSearchParams({ metric: metricKey, storeId: state.storeId, startDate: $("analysisStart").value, endDate: $("analysisEnd").value }).toString();
  }

  function setPeriod(period) {
    const range = window.StoreAnalyticsData.periodRange(period);
    if (range) {
      $("analysisStart").value = range.startDate;
      $("analysisEnd").value = range.endDate;
    }
    const custom = period === "custom";
    $("analysisStart").disabled = !custom;
    $("analysisEnd").disabled = !custom;
  }

  function validateRange() {
    const startDate = $("analysisStart").value;
    const endDate = $("analysisEnd").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error("请选择完整的开始和结束日期。");
    if (startDate > endDate) throw new Error("开始日期不能晚于结束日期。");
    const days = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
    if (days > 366) throw new Error("单次最多统计 366 天。");
    return { startDate, endDate };
  }

  function sortedRows(rows) {
    return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => Number(b.value || 0) - Number(a.value || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
  }

  function renderChart(targetId, rows, includePhone = false) {
    const target = $(targetId);
    const sorted = sortedRows(rows);
    if (!sorted.length) {
      target.innerHTML = '<p class="query-empty">暂无统计对象</p>';
      return;
    }
    const max = Math.max(1, ...sorted.map((row) => Number(row.value || 0)));
    target.innerHTML = `<div class="store-chart-bars" style="--bar-count:${sorted.length}">${sorted.map((row) => {
      const value = Number(row.value || 0);
      const height = value ? Math.max(8, Math.round(value / max * 100)) : 2;
      const phone = includePhone && row.phone ? `<small>${escapeHtml(row.phone)}</small>` : "";
      return `<article class="store-chart-item"><strong class="store-chart-value">${value}</strong><div class="store-chart-column" style="height:${height}%" aria-label="${escapeHtml(row.name)} ${value} 次"></div><span class="store-chart-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name || "未命名")}</span>${phone}</article>`;
    }).join("")}</div>`;
  }

  function render(data) {
    const range = data.range || {};
    const dimension = data.dimensions?.[metric] || {};
    state.storeId = String(data.store?.storeId || state.storeId);
    $("analysisTitle").textContent = `${metrics[metric]}统计`;
    document.title = `${metrics[metric]}统计 · ${data.store?.storeName || "门店"}`;
    $("analysisStoreName").textContent = data.store?.storeName || "门店业务";
    $("analysisRangeText").textContent = `${range.startDate || "—"} 至 ${range.endDate || "—"} · 汇总 ${Number(data.totals?.[metric] || 0)} 次`;
    $("analysisSubtitle").textContent = "按门店、老师、项目统计；区间业务与活跃对象均纳入";
    $("analysisStatus").innerHTML = `<span></span>${metrics[metric]} ${Number(data.totals?.[metric] || 0)} 次`;
    $("analysisMetricTabs").innerHTML = Object.entries(metrics).map(([key, label]) => `<a class="${key === metric ? "active" : ""}" href="store-analysis.html?${currentQuery(key)}">${label}</a>`).join("");
    const back = `store-detail.html?storeId=${encodeURIComponent(state.storeId)}`;
    $("analysisBack").href = back;
    $("analysisBackSide").href = back;
    renderChart("storeAnalysisChart", dimension.stores, true);
    renderChart("teacherAnalysisChart", dimension.teachers, true);
    renderChart("productAnalysisChart", dimension.products, false);
    $("exportAnalysisPdf").disabled = false;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    $("analysisMessage").textContent = "正在统计…";
    $("exportAnalysisPdf").disabled = true;
    try {
      const range = validateRange();
      const data = await window.StoreAnalyticsData.load({ storeId: state.storeId, ...range });
      state.data = data;
      render(data);
      history.replaceState(null, "", `store-analysis.html?${currentQuery(metric)}`);
      $("analysisMessage").textContent = "";
    } catch (error) {
      state.data = null;
      $("analysisStatus").textContent = "统计失败";
      $("analysisMessage").textContent = error?.message || "统计读取失败";
      ["storeAnalysisChart", "teacherAnalysisChart", "productAnalysisChart"].forEach((id) => { $(id).innerHTML = '<p class="query-empty">暂无数据</p>'; });
    } finally {
      state.loading = false;
    }
  }

  async function exportPdf() {
    if (!state.data) return;
    const button = $("exportAnalysisPdf");
    button.disabled = true;
    $("analysisMessage").textContent = "正在生成表格版 PDF…";
    try {
      const result = await window.StoreDashboardExport.exportReport({ data: state.data, metric });
      $("analysisMessage").textContent = `已导出 ${result.pages} 页 PDF`;
    } catch (error) {
      $("analysisMessage").textContent = error?.message || "PDF 导出失败";
    } finally {
      button.disabled = false;
    }
  }

  function initializeDates() {
    const startDate = String(params.get("startDate") || "");
    const endDate = String(params.get("endDate") || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      const preset = ["today", "last7", "month"].find((key) => {
        const range = window.StoreAnalyticsData.periodRange(key);
        return range.startDate === startDate && range.endDate === endDate;
      });
      $("analysisPeriod").value = preset || "custom";
      if (preset) setPeriod(preset);
      else {
        $("analysisStart").value = startDate;
        $("analysisEnd").value = endDate;
        setPeriod("custom");
      }
    } else {
      setPeriod("today");
    }
  }

  document.documentElement.dataset.prototypeVersion = VERSION;
  initializeDates();
  $("analysisPeriod").addEventListener("change", (event) => setPeriod(event.target.value));
  $("applyAnalysis").addEventListener("click", () => void load());
  $("exportAnalysisPdf").addEventListener("click", () => void exportPdf());
  void load();
})();

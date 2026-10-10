(() => {
  "use strict";
  const VERSION = "0.2.0";
  const MAX_LENGTH = 200;
  const $ = (id) => document.getElementById(id);
  const fields = [
    ["dailyCompletedWork", "dailyCompletedWorkCount", "completedWork"],
    ["dailyCustomerProjectProgress", "dailyCustomerProjectProgressCount", "customerProjectProgress"],
    ["dailyProblemsAndSupport", "dailyProblemsAndSupportCount", "problemsAndSupport"],
    ["dailyTomorrowPlan", "dailyTomorrowPlanCount", "tomorrowPlan"]
  ];
  const state = { serverToday: "", selectedDate: "", visibleMonth: "", reports: new Set(), loading: false, editing: false, mode: "readonly", currentReport: null };
  let app = null;

  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : null; } catch (_) { return null; }
  }
  function responseData(result) {
    return [result?.result, result?.data?.result, result?.data, result]
      .map(parsedObject)
      .find((candidate) => candidate && (Object.prototype.hasOwnProperty.call(candidate, "ok") || Object.prototype.hasOwnProperty.call(candidate, "code"))) || {};
  }
  function register(registerFn, name) {
    if (typeof registerFn !== "function") return;
    try { registerFn(window.cloudbase); } catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      if (!(message.includes("duplicate component") && message.includes(name))) throw error;
    }
  }
  async function callDailyReport(action, data = {}) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("日报服务尚未加载，请刷新后重试。");
    register(window.registerAuth, "auth");
    register(window.registerFunctions, "functions");
    app ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    const raw = await app.callFunction({ name: "staffAccount", data: { action, ...data } });
    const result = responseData(raw);
    if (!result.ok) throw new Error(result.message || "日报服务暂时不可用。");
    return result;
  }
  function shanghaiToday() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }
  function dateFromText(text) { const [year, month, day] = text.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day)); }
  function dateText(date) { return date.toISOString().slice(0, 10); }
  function monthShift(monthText, amount) { const [year, month] = monthText.split("-").map(Number); return dateText(new Date(Date.UTC(year, month - 1 + amount, 1))).slice(0, 7); }
  function formatDate(text) { const date = dateFromText(text); return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`; }
  function setBusy(busy) {
    state.loading = busy;
    $("dailyReportPreviousMonth").disabled = busy;
    $("dailyReportNextMonth").disabled = busy || Boolean(state.serverToday && monthShift(state.visibleMonth, 1) > state.serverToday.slice(0, 7));
    $("dailyReportYear").disabled = busy;
    $("dailyReportMonth").disabled = busy;
  }
  function updateCounts() { fields.forEach(([fieldId, countId]) => { $(countId).textContent = Array.from($(fieldId).value).length; }); }
  function setForm(report, mode) {
    const values = report || {};
    state.mode = mode;
    state.currentReport = report || null;
    state.editing = mode === "editable" && !report;
    fields.forEach(([fieldId, , key]) => { $(fieldId).value = values[key] || ""; $(fieldId).disabled = mode !== "editable" || !state.editing; });
    const stateLabel = mode === "editable" ? "今天可编辑" : mode === "future" ? "未来日期" : report ? "历史只读" : "当天未填写";
    $("dailyReportState").textContent = stateLabel;
    $("dailyReportState").dataset.state = mode;
    $("dailyReportEdit").hidden = !(mode === "editable" && report && !state.editing);
    $("dailyReportSave").hidden = !(mode === "editable" && state.editing);
    $("dailyReportMessage").textContent = mode === "future" ? "未来日期不能提前填写日报。" : mode === "readonly" && !report ? "这一天没有填写日报。" : "";
    updateCounts();
  }
  function populateSelectors() {
    const todayYear = Number((state.serverToday || shanghaiToday()).slice(0, 4));
    const selectedYear = Number(state.visibleMonth.slice(0, 4));
    $("dailyReportYear").innerHTML = Array.from({ length: Math.max(1, todayYear - 2019) }, (_, index) => 2020 + index).map((year) => `<option value="${year}">${year}年</option>`).join("");
    $("dailyReportMonth").innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${String(index + 1).padStart(2, "0")}">${index + 1}月</option>`).join("");
    $("dailyReportYear").value = String(Math.max(2020, selectedYear));
    $("dailyReportMonth").value = state.visibleMonth.slice(5, 7);
  }
  function renderCalendar() {
    const [year, month] = state.visibleMonth.split("-").map(Number);
    const first = new Date(Date.UTC(year, month - 1, 1));
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const blanks = (first.getUTCDay() + 6) % 7;
    const cells = Array.from({ length: blanks }, () => '<span class="daily-calendar-blank" aria-hidden="true"></span>');
    for (let day = 1; day <= days; day += 1) {
      const current = `${state.visibleMonth}-${String(day).padStart(2, "0")}`;
      const future = Boolean(state.serverToday && current > state.serverToday);
      const classes = ["daily-calendar-day", current === state.selectedDate ? "selected" : "", current === state.serverToday ? "today" : "", state.reports.has(current) ? "has-report" : ""].filter(Boolean).join(" ");
      cells.push(`<button type="button" role="gridcell" class="${classes}" data-report-date="${current}" aria-label="${formatDate(current)}${state.reports.has(current) ? "，已提交" : ""}" ${future ? "disabled" : ""}>${day}</button>`);
    }
    $("dailyReportCalendar").innerHTML = cells.join("");
    $("dailyReportCalendar").querySelectorAll("[data-report-date]").forEach((button) => button.addEventListener("click", () => selectDate(button.dataset.reportDate)));
    populateSelectors();
    $("dailyReportNextMonth").disabled = state.loading || Boolean(state.serverToday && monthShift(state.visibleMonth, 1) > state.serverToday.slice(0, 7));
  }
  async function loadMonth(month, preferredDate = "") {
    setBusy(true);
    $("dailyCalendarMessage").textContent = "正在读取日报日历…";
    try {
      const result = await callDailyReport("getOwnDailyReportMonth", { month });
      state.serverToday = result.serverToday;
      state.visibleMonth = result.month;
      state.reports = new Set((result.reports || []).map((report) => report.reportDate));
      const candidate = preferredDate && preferredDate.startsWith(month) ? preferredDate : month === state.serverToday.slice(0, 7) ? state.serverToday : `${month}-01`;
      state.selectedDate = candidate > state.serverToday ? state.serverToday : candidate;
      renderCalendar();
      $("dailyCalendarMessage").textContent = "";
      await loadSelectedReport();
    } catch (error) {
      $("dailyCalendarMessage").textContent = error?.message || "日报日历读取失败。";
      setForm(null, "readonly");
    } finally { setBusy(false); }
  }
  async function loadSelectedReport() {
    $("dailyReportDateLabel").textContent = `${formatDate(state.selectedDate)} · 正在读取…`;
    $("dailyReportMessage").textContent = "";
    try {
      const result = await callDailyReport("getOwnDailyReport", { reportDate: state.selectedDate });
      state.serverToday = result.serverToday;
      const mode = result.future ? "future" : result.editable ? "editable" : "readonly";
      $("dailyReportDateLabel").textContent = `${formatDate(state.selectedDate)} · ${mode === "editable" ? "上海时间今天" : "历史记录"}`;
      setForm(result.report, mode);
    } catch (error) {
      $("dailyReportMessage").textContent = error?.message || "日报读取失败。";
      setForm(null, "readonly");
    }
  }
  async function selectDate(date) { if (date > state.serverToday) return; state.selectedDate = date; renderCalendar(); await loadSelectedReport(); }
  function selectedMonthFromControls() { return `${$("dailyReportYear").value}-${$("dailyReportMonth").value}`; }

  fields.forEach(([fieldId]) => $(fieldId).addEventListener("input", updateCounts));
  $("dailyReportEdit").addEventListener("click", () => {
    if (state.mode !== "editable" || !state.currentReport) return;
    state.editing = true;
    fields.forEach(([fieldId]) => { $(fieldId).disabled = false; });
    $("dailyReportEdit").hidden = true;
    $("dailyReportSave").hidden = false;
    $("dailyReportState").textContent = "编辑中";
    $("dailyReportMessage").textContent = "修改四栏内容后，点击确认提交。";
  });
  $("dailyReportPreviousMonth").addEventListener("click", () => loadMonth(monthShift(state.visibleMonth, -1)));
  $("dailyReportNextMonth").addEventListener("click", () => loadMonth(monthShift(state.visibleMonth, 1)));
  $("dailyReportYear").addEventListener("change", () => loadMonth(selectedMonthFromControls()));
  $("dailyReportMonth").addEventListener("change", () => loadMonth(selectedMonthFromControls()));
  $("dailyReportToday").addEventListener("click", () => loadMonth(state.serverToday.slice(0, 7), state.serverToday));
  $("dailyReportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.selectedDate !== state.serverToday) return;
    const payload = { reportDate: state.selectedDate };
    fields.forEach(([fieldId, , key]) => { payload[key] = $(fieldId).value.trim(); });
    if (!payload.completedWork) { $("dailyReportMessage").textContent = "请填写今日完成事项。"; $("dailyCompletedWork").focus(); return; }
    if (fields.some(([fieldId]) => Array.from($(fieldId).value.trim()).length > MAX_LENGTH)) { $("dailyReportMessage").textContent = `每项内容不能超过 ${MAX_LENGTH} 个字符。`; return; }
    $("dailyReportSave").disabled = true;
    $("dailyReportMessage").textContent = "正在保存…";
    try {
      const result = await callDailyReport("saveOwnDailyReport", payload);
      setForm(result.report, "editable");
      state.reports.add(state.selectedDate);
      renderCalendar();
      $("dailyReportMessage").textContent = "今日日报已提交。当天结束前可点击编辑继续修改。";
    } catch (error) { $("dailyReportMessage").textContent = error?.message || "日报保存失败。"; }
    finally { $("dailyReportSave").disabled = false; }
  });

  state.serverToday = shanghaiToday();
  state.visibleMonth = state.serverToday.slice(0, 7);
  state.selectedDate = state.serverToday;
  loadMonth(state.visibleMonth, state.selectedDate);
  window.DailyReportVersion = VERSION;
})();

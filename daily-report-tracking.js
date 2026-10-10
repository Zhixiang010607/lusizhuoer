(() => {
  "use strict";
  const VERSION = "0.1.0";
  const $ = (id) => document.getElementById(id);
  const state = { serverToday: "", selectedDate: "", visibleMonth: "", loading: false };
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
  async function callTracking(action, data = {}) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("日报追踪服务尚未加载，请刷新后重试。");
    register(window.registerAuth, "auth");
    register(window.registerFunctions, "functions");
    app ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    const raw = await app.callFunction({ name: "staffAccount", data: { action, ...data } });
    const result = responseData(raw);
    if (!result.ok) throw new Error(result.message || "日报追踪服务暂时不可用。");
    return result;
  }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
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
    $("trackingPreviousMonth").disabled = busy;
    $("trackingNextMonth").disabled = busy || Boolean(state.serverToday && monthShift(state.visibleMonth, 1) > state.serverToday.slice(0, 7));
    $("trackingYear").disabled = busy;
    $("trackingMonth").disabled = busy;
  }
  function populateSelectors() {
    const todayYear = Number((state.serverToday || shanghaiToday()).slice(0, 4));
    const selectedYear = Number(state.visibleMonth.slice(0, 4));
    $("trackingYear").innerHTML = Array.from({ length: Math.max(1, todayYear - 2019) }, (_, index) => 2020 + index).map((year) => `<option value="${year}">${year}年</option>`).join("");
    $("trackingMonth").innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${String(index + 1).padStart(2, "0")}">${index + 1}月</option>`).join("");
    $("trackingYear").value = String(Math.max(2020, selectedYear));
    $("trackingMonth").value = state.visibleMonth.slice(5, 7);
  }
  function renderCalendar() {
    const [year, month] = state.visibleMonth.split("-").map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const blanks = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
    const cells = Array.from({ length: blanks }, () => '<span class="daily-calendar-blank" aria-hidden="true"></span>');
    for (let day = 1; day <= days; day += 1) {
      const current = `${state.visibleMonth}-${String(day).padStart(2, "0")}`;
      const future = current > state.serverToday;
      const classes = ["daily-calendar-day", current === state.selectedDate ? "selected" : "", current === state.serverToday ? "today" : ""].filter(Boolean).join(" ");
      cells.push(`<button type="button" role="gridcell" class="${classes}" data-tracking-date="${current}" aria-label="${formatDate(current)}" ${future ? "disabled" : ""}>${day}</button>`);
    }
    $("trackingCalendar").innerHTML = cells.join("");
    $("trackingCalendar").querySelectorAll("[data-tracking-date]").forEach((button) => button.addEventListener("click", () => selectDate(button.dataset.trackingDate)));
    populateSelectors();
    $("trackingNextMonth").disabled = state.loading || monthShift(state.visibleMonth, 1) > state.serverToday.slice(0, 7);
  }
  function card(teacher) {
    const teacherLink = `staff-detail.html?role=teacher&id=${encodeURIComponent(teacher.teacherId)}`;
    const detailLink = teacher.completed ? `daily-report-tracking.html?date=${encodeURIComponent(state.selectedDate)}&reportId=${encodeURIComponent(teacher.reportId)}` : "";
    return `<article class="daily-tracking-card">
      <a class="record-link" href="${teacherLink}"><span class="daily-tracking-card-label">老师姓名</span>${escapeHtml(teacher.teacherName || teacher.teacherCode || "未命名老师")}</a>
      <span><span class="daily-tracking-card-label">老师电话</span>${escapeHtml(teacher.phone || "未登记")}</span>
      ${teacher.completed ? `<a class="record-link" href="${detailLink}"><span class="daily-tracking-card-label">日报内容</span>查看日报</a>` : '<span><span class="daily-tracking-card-label">日报内容</span>—</span>'}
      <span class="daily-tracking-status ${teacher.completed ? "complete" : "incomplete"}"><span class="daily-tracking-card-label">日报完成</span>${teacher.completed ? "是" : "否"}</span>
    </article>`;
  }
  function renderLists(result) {
    const completed = result.completed || [];
    const incomplete = result.incomplete || [];
    $("trackingCompletedCount").textContent = `${completed.length} 人`;
    $("trackingIncompleteCount").textContent = `${incomplete.length} 人`;
    $("trackingCompletedSummary").textContent = `已填写 ${completed.length}`;
    $("trackingIncompleteSummary").textContent = `未填写 ${incomplete.length}`;
    $("trackingCompleted").innerHTML = completed.length ? completed.map(card).join("") : '<p class="daily-tracking-empty">所选日期暂无老师填写日报</p>';
    $("trackingIncomplete").innerHTML = incomplete.length ? incomplete.map(card).join("") : '<p class="daily-tracking-empty">全部在职老师均已填写</p>';
  }
  async function loadDay(date) {
    setBusy(true);
    $("trackingDateTitle").textContent = `${formatDate(date)} · 正在读取…`;
    $("trackingMessage").textContent = "";
    try {
      const result = await callTracking("getHqDailyReportTrackingDay", { reportDate: date });
      state.serverToday = result.serverToday;
      state.selectedDate = result.reportDate;
      state.visibleMonth = state.selectedDate.slice(0, 7);
      renderCalendar();
      renderLists(result);
      $("trackingDateTitle").textContent = `${formatDate(state.selectedDate)} · 在职老师日报`;
      history.replaceState(null, "", `daily-report-tracking.html?date=${encodeURIComponent(state.selectedDate)}`);
    } catch (error) {
      $("trackingMessage").textContent = error?.message || "日报追踪读取失败。";
      renderLists({ completed: [], incomplete: [] });
    } finally { setBusy(false); }
  }
  async function selectDate(date) { if (date > state.serverToday) return; await loadDay(date); }
  function selectedMonth() { return `${$("trackingYear").value}-${$("trackingMonth").value}`; }
  async function loadMonth(month) {
    const candidate = month === state.serverToday.slice(0, 7) ? state.serverToday : `${month}-01`;
    state.visibleMonth = month;
    renderCalendar();
    await loadDay(candidate);
  }
  async function openDetail(reportId) {
    if (!reportId) return;
    try {
      const result = await callTracking("getHqDailyReportDetail", { reportId });
      const teacher = result.teacher || {};
      const report = result.report || {};
      $("dailyReportDetailTitle").textContent = `${teacher.teacherName || teacher.teacherCode || "老师"}的日报`;
      $("dailyReportDetailMeta").textContent = `${formatDate(report.reportDate)} · 电话 ${teacher.phone || "未登记"} · 只读`;
      const sections = [["今日完成事项", report.completedWork], ["客户或项目进展", report.customerProjectProgress], ["遇到的问题", report.problemsAndSupport], ["明日计划", report.tomorrowPlan]];
      $("dailyReportDetailBody").innerHTML = sections.map(([title, value]) => `<section class="daily-report-detail-item"><h3>${title}</h3><p>${escapeHtml(value || "")}</p></section>`).join("");
      $("dailyReportDetailDialog").showModal();
    } catch (error) { $("trackingMessage").textContent = error?.message || "日报详情读取失败。"; }
  }

  $("trackingPreviousMonth").addEventListener("click", () => loadMonth(monthShift(state.visibleMonth, -1)));
  $("trackingNextMonth").addEventListener("click", () => loadMonth(monthShift(state.visibleMonth, 1)));
  $("trackingYear").addEventListener("change", () => loadMonth(selectedMonth()));
  $("trackingMonth").addEventListener("change", () => loadMonth(selectedMonth()));
  $("trackingToday").addEventListener("click", () => loadDay(state.serverToday));
  $("dailyReportDetailDialog").addEventListener("close", () => history.replaceState(null, "", `daily-report-tracking.html?date=${encodeURIComponent(state.selectedDate)}`));

  const query = new URLSearchParams(location.search);
  state.serverToday = shanghaiToday();
  const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(query.get("date") || "") && query.get("date") <= state.serverToday ? query.get("date") : state.serverToday;
  state.selectedDate = requestedDate;
  state.visibleMonth = requestedDate.slice(0, 7);
  renderCalendar();
  loadDay(requestedDate).then(() => openDetail(query.get("reportId") || ""));
  window.DailyReportTrackingVersion = VERSION;
})();

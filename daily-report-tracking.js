(() => {
  "use strict";
  const VERSION = "0.3.0";
  const $ = (id) => document.getElementById(id);
  const shanghaiDateTime = window.WebWorkCommon?.shanghaiDateTime || (() => "—");
  const state = { serverToday: "", selectedDate: "", visibleMonth: "", loading: false };
  let app = null;
  let datePicker;

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
  function submittedDateTime(teacher) {
    if (!teacher?.completed) return "—";
    return shanghaiDateTime(teacher.updatedAt || teacher.updated_at);
  }
  function submittedTime(teacher) {
    const value = submittedDateTime(teacher);
    const match = value.match(/(\d{2}:\d{2})(?::\d{2})?/);
    return match ? match[1] : "—";
  }
  function setBusy(busy) {
    state.loading = busy;
    datePicker?.busy(busy);
    $("trackingDateConfirm").disabled = busy;
    $("trackingToday").disabled = busy;
  }
  function card(teacher) {
    const teacherLink = `staff-detail.html?role=teacher&id=${encodeURIComponent(teacher.teacherId)}`;
    return `<td><a class="record-link" href="${teacherLink}">${escapeHtml(teacher.teacherName || "未命名老师")}</a></td><td>${escapeHtml(teacher.phone || "未登记")}</td><td>${teacher.completed ? `<button class="tracking-text-link" data-report-id="${escapeHtml(teacher.reportId)}" type="button">查看日报</button>` : "—"}</td><td>${escapeHtml(submittedTime(teacher))}</td><td><span class="daily-tracking-status ${teacher.completed ? "complete" : "incomplete"}">${teacher.completed ? "是" : "否"}</span></td>`;
  }
  function renderLists(result) {
    const completed = result.completed || [];
    const incomplete = result.incomplete || [];
    $("trackingCompletedCount").textContent = `${completed.length} 人`;
    $("trackingIncompleteCount").textContent = `${incomplete.length} 人`;
    $("trackingCompletedSummary").textContent = `已填写 ${completed.length}`;
    $("trackingIncompleteSummary").textContent = `未填写 ${incomplete.length}`;
    const head = ["老师姓名", "老师电话", "日报内容", "提交时间（北京）", "是否完成"];
    window.WebTrackingUI.table($("trackingCompleted"), { rows: completed, head, row: card, empty: "所选日期暂无老师填写日报" });
    window.WebTrackingUI.table($("trackingIncomplete"), { rows: incomplete, head, row: card, empty: "全部在职老师均已填写" });
  }
  async function loadDay(date) {
    if (state.loading) return;
    setBusy(true);
    $("trackingDateTitle").textContent = `${formatDate(date)} · 正在读取…`;
    $("trackingMessage").textContent = "";
    try {
      const result = await callTracking("getHqDailyReportTrackingDay", { reportDate: date });
      state.serverToday = result.serverToday;
      state.selectedDate = result.reportDate;
      state.visibleMonth = state.selectedDate.slice(0, 7);
      datePicker.set(state.selectedDate, state.serverToday);
      renderLists(result);
      $("trackingDateTitle").textContent = `${formatDate(state.selectedDate)} · 在职老师日报`;
      history.replaceState(null, "", `daily-report-tracking.html?date=${encodeURIComponent(state.selectedDate)}`);
    } catch (error) {
      $("trackingMessage").textContent = error?.message || "日报追踪读取失败。";
      renderLists({ completed: [], incomplete: [] });
    } finally { setBusy(false); }
  }
  async function openDetail(reportId) {
    if (!reportId) return;
    try {
      const result = await callTracking("getHqDailyReportDetail", { reportId });
      const teacher = result.teacher || {};
      const report = result.report || {};
      $("dailyReportDetailTitle").textContent = `${teacher.teacherName || teacher.teacherCode || "老师"}的日报`;
      const submittedAt = shanghaiDateTime(report.updatedAt || report.updated_at);
      $("dailyReportDetailMeta").textContent = `${formatDate(report.reportDate)} · 提交时间 ${submittedAt}（北京时间） · 电话 ${teacher.phone || "未登记"} · 只读`;
      const sections = [["今日完成事项", report.completedWork]];
      $("dailyReportDetailBody").innerHTML = sections.map(([title, value]) => `<section class="daily-report-detail-item"><h3>${title}</h3><p>${escapeHtml(value || "")}</p></section>`).join("");
      $("dailyReportDetailDialog").showModal();
    } catch (error) { $("trackingMessage").textContent = error?.message || "日报详情读取失败。"; }
  }

  $("trackingDateConfirm").addEventListener("click", () => loadDay(datePicker.value()));
  $("trackingToday").addEventListener("click", () => loadDay(state.serverToday));
  $("trackingCompleted").addEventListener("click", (event) => {
    const target = event.target.closest("[data-report-id]");
    if (target) void openDetail(target.dataset.reportId);
  });
  $("dailyReportDetailDialog").addEventListener("close", () => history.replaceState(null, "", `daily-report-tracking.html?date=${encodeURIComponent(state.selectedDate)}`));

  const query = new URLSearchParams(location.search);
  state.serverToday = shanghaiToday();
  const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(query.get("date") || "") && query.get("date") <= state.serverToday ? query.get("date") : state.serverToday;
  state.selectedDate = requestedDate;
  state.visibleMonth = requestedDate.slice(0, 7);
  datePicker = window.WebTrackingUI.dateSelector($("dailyTrackingDateParts"), requestedDate, state.serverToday);
  loadDay(requestedDate).then(() => openDetail(query.get("reportId") || ""));
  window.DailyReportTrackingVersion = VERSION;
})();

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const C = window.WebWorkCommon;
  const state = { mode: "attendance", month: "", serverToday: "", selectedDate: "", data: null, loading: false };
  const recordTime = (row) => C.shanghaiDateTime(row?.checkedInAt);
  function attendanceByDate() {
    const map = new Map();
    for (const row of state.data?.attendance || []) {
      if (!map.has(row.attendanceDate)) map.set(row.attendanceDate, {});
      map.get(row.attendanceDate)[row.attendanceType] = row;
    }
    return map;
  }
  function reportByDate() { return new Map((state.data?.reports || []).map((row) => [row.reportDate, row])); }
  function statusFor(date, exists) {
    if (date < state.data.teacher.employmentStartDate) return "not-employed";
    if (date > state.serverToday) return "future";
    return exists ? "done" : "missing";
  }
  function renderLegend() {
    $("workLegend").innerHTML = state.mode === "attendance"
      ? '<span><i class="work-dot done"></i>已打卡</span><span><i class="work-dot missing"></i>未打卡</span><span><i class="work-dot not-employed"></i>未入职</span><b>左点上班，右点下班</b>'
      : '<span><i class="work-dot done"></i>已写日报</span><span><i class="work-dot missing"></i>未写日报</span><span><i class="work-dot not-employed"></i>未入职</span>';
  }
  function renderCalendar() {
    const attendance = attendanceByDate(), reports = reportByDate();
    const cells = Array.from({ length: C.monthBlankCount(state.month) }, () => '<span class="work-day blank" aria-hidden="true"></span>');
    for (let day = 1; day <= C.daysInMonth(state.month); day += 1) {
      const date = `${state.month}-${String(day).padStart(2, "0")}`;
      const notEmployed = date < state.data.teacher.employmentStartDate;
      const current = attendance.get(date) || {};
      let indicators = "";
      if (notEmployed) indicators = '<span class="work-not-employed">未入职</span>';
      else if (state.mode === "attendance") indicators = `<span class="work-dots"><i class="work-dot ${statusFor(date, current.CLOCK_IN)}"></i><i class="work-dot ${statusFor(date, current.CLOCK_OUT)}"></i></span>`;
      else indicators = `<span class="work-dots"><i class="work-dot ${statusFor(date, reports.has(date))}"></i></span>`;
      cells.push(`<button type="button" role="gridcell" class="work-day ${date === state.selectedDate ? "selected" : ""} ${date > state.serverToday ? "future" : ""} ${notEmployed ? "not-employed" : ""}" data-date="${date}"><span class="work-day-number">${day}</span>${indicators}</button>`);
    }
    $("workCalendar").innerHTML = cells.join("");
    $("workCalendar").querySelectorAll("[data-date]").forEach((button) => button.addEventListener("click", () => { state.selectedDate = button.dataset.date; renderCalendar(); renderDetail(); }));
    $("workMonth").value = state.month;
    $("workMonth").max = state.serverToday.slice(0, 7);
    $("workNextMonth").disabled = C.monthShift(state.month, 1) > state.serverToday.slice(0, 7);
    $("workNextYear").disabled = C.monthShift(state.month, 12) > state.serverToday.slice(0, 7);
    renderLegend();
  }
  function mapButton(row) {
    if (!row) return "";
    return `<a class="button-link secondary-button" target="_blank" rel="noopener noreferrer" href="${C.mapLink(row)}">在地图中打开</a>`;
  }
  function punchCard(title, row, canPunch, waitingForClockIn = false) {
    if (!row) return `<article class="work-detail-card"><h3>${title}</h3><div class="empty-copy">${waitingForClockIn ? "需先完成上班打卡" : "未打卡"}</div>${canPunch ? '<a class="button-link" href="attendance.html">立即办理</a>' : ""}</article>`;
    return `<article class="work-detail-card"><h3>${title}</h3><strong>${recordTime(row)}（北京时间）</strong><span>${C.escapeHtml(row.placeName || "未解析附近地点")}</span><span>${C.escapeHtml(row.formattedAddress || "暂无文字地址")}</span><span>精度约 ${C.escapeHtml(row.accuracy)} 米</span>${mapButton(row)}</article>`;
  }
  function renderDetail() {
    const date = state.selectedDate;
    if (!date) return;
    const teacher = state.data.teacher;
    if (date < teacher.employmentStartDate) { $("workDetail").innerHTML = `<div class="panel-heading"><div><h2>${date}</h2><p>${C.escapeHtml(teacher.teacherName)} · ${C.escapeHtml(teacher.phone)}</p></div><span class="badge">未入职</span></div><div class="empty-copy">该日期尚未入职</div>`; return; }
    if (state.mode === "report") {
      const report = reportByDate().get(date);
      $("workDetail").innerHTML = `<div class="panel-heading"><div><h2>${date} 日报</h2><p>${C.escapeHtml(teacher.teacherName)} · ${C.escapeHtml(teacher.phone)}</p></div><span class="badge">${report ? "已填写" : "未填写"}</span></div>${report ? `<div class="work-report-copy">${C.escapeHtml(report.completedWork || "")}</div>` : '<div class="empty-copy">当天没有日报</div>'}${date === state.serverToday ? `<a class="button-link" href="daily-report.html">${report ? "修改今日日报" : "填写今日日报"}</a>` : ""}`;
      return;
    }
    const current = attendanceByDate().get(date) || {};
    const duration = current.CLOCK_IN && current.CLOCK_OUT ? Math.max(0, (new Date(current.CLOCK_OUT.checkedInAt) - new Date(current.CLOCK_IN.checkedInAt)) / 1000) : null;
    $("workDetail").innerHTML = `<div class="panel-heading"><div><h2>${date} 考勤详情</h2><p>${C.escapeHtml(teacher.teacherName)} · ${C.escapeHtml(teacher.phone)}</p></div><span class="badge">${duration === null ? "未完整打卡" : C.duration(duration)}</span></div><div class="work-detail-grid">${punchCard("上班打卡", current.CLOCK_IN, date === state.serverToday && !current.CLOCK_IN)}${punchCard("下班打卡", current.CLOCK_OUT, date === state.serverToday && Boolean(current.CLOCK_IN) && !current.CLOCK_OUT, date === state.serverToday && !current.CLOCK_IN)}</div>`;
  }
  async function load(month, preferred = "") {
    if (state.loading) return;
    state.loading = true;
    $("workMessage").textContent = "正在读取月度记录…";
    try {
      const result = await C.call("staffAccount", "getOwnTeacherWorkMonth", { month });
      state.data = result;
      state.month = result.month;
      state.serverToday = result.serverToday;
      state.selectedDate = preferred?.startsWith(state.month) ? preferred : state.month === state.serverToday.slice(0, 7) ? state.serverToday : `${state.month}-01`;
      renderCalendar(); renderDetail();
      $("workMessage").textContent = "";
    } catch (error) { $("workMessage").textContent = error.message || "月度记录读取失败。"; }
    finally { state.loading = false; }
  }
  function setMode(mode) { state.mode = mode; $("workAttendanceMode").classList.toggle("active", mode === "attendance"); $("workReportMode").classList.toggle("active", mode === "report"); renderCalendar(); renderDetail(); history.replaceState(null, "", `work-calendar.html?mode=${mode}`); }
  $("workAttendanceMode").addEventListener("click", () => setMode("attendance"));
  $("workReportMode").addEventListener("click", () => setMode("report"));
  $("workMonth").addEventListener("change", () => load($("workMonth").value));
  $("workPreviousYear").addEventListener("click", () => load(C.monthShift(state.month, -12)));
  $("workNextYear").addEventListener("click", () => load(C.monthShift(state.month, 12)));
  $("workPreviousMonth").addEventListener("click", () => load(C.monthShift(state.month, -1)));
  $("workNextMonth").addEventListener("click", () => load(C.monthShift(state.month, 1)));
  $("workToday").addEventListener("click", () => load(state.serverToday.slice(0, 7), state.serverToday));
  $("workReload").addEventListener("click", () => load(state.month, state.selectedDate));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  state.month = today.slice(0, 7);
  $("workMonth").value = state.month;
  $("workMonth").max = state.month;
  state.mode = new URLSearchParams(location.search).get("mode") === "report" ? "report" : "attendance";
  setMode(state.mode);
  load(state.month, today);
})();

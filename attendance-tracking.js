(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const C = window.WebWorkCommon;
  const state = { date: "", serverToday: "", teachers: new Map(), loading: false };
  let datePicker;
  const groups = [
    ["completed", "完整打卡", "所选日期暂无完整打卡老师"],
    ["clockInOnly", "仅上班打卡", "所选日期暂无仅上班打卡老师"],
    ["clockOutOnly", "仅下班打卡", "所选日期暂无仅下班打卡老师"],
    ["missing", "未打卡", "全部在职老师均已有打卡记录"]
  ];
  const time = (row) => row ? `${C.shanghaiDateTime(row.checkedInAt)}（北京时间）` : "—";
  function detailButton(teacher, kind) { return teacher[kind] ? `<button class="tracking-detail-button secondary-button" type="button" data-teacher="${teacher.teacherId}" data-kind="${kind}">查看详情</button>` : "—"; }
  function tableRow(teacher) {
    return `<td><a href="staff-detail.html?role=teacher&id=${encodeURIComponent(teacher.teacherId)}">${C.escapeHtml(teacher.teacherName || "未命名老师")}</a></td><td>${C.escapeHtml(teacher.phone || "未登记")}</td><td>${teacher.clockIn ? C.escapeHtml(C.shanghaiDateTime(teacher.clockIn.checkedInAt).slice(11)) : "—"}</td><td>${detailButton(teacher, "clockIn")}</td><td>${teacher.clockOut ? C.escapeHtml(C.shanghaiDateTime(teacher.clockOut.checkedInAt).slice(11)) : "—"}</td><td>${detailButton(teacher, "clockOut")}</td><td>${teacher.clockIn && teacher.clockOut ? C.duration(teacher.workDurationSeconds) : "—"}</td>`;
  }
  function render(result) {
    state.teachers.clear();
    groups.forEach(([key]) => (result[key] || []).forEach((teacher) => state.teachers.set(String(teacher.teacherId), teacher)));
    $("attendanceTrackingTitle").textContent = `${result.attendanceDate} · 在职老师考勤`;
    $("attendanceTrackingSummary").innerHTML = groups.map(([key, label]) => `<span>${label} ${(result[key] || []).length}</span>`).join("");
    $("attendanceTrackingGroups").innerHTML = groups.map(([key, label]) => `<section class="panel tracking-group"><div class="panel-heading"><h2>${label}</h2><span class="badge">${(result[key] || []).length} 人</span></div><div data-tracking-table="${key}"></div></section>`).join("");
    groups.forEach(([key,,empty]) => window.WebTrackingUI.table(document.querySelector(`[data-tracking-table="${key}"]`), { rows: result[key] || [], head: ["老师姓名", "老师电话", "上班时间（北京）", "上班详情", "下班时间（北京）", "下班详情", "工作时长"], row: tableRow, empty }));
  }
  function mapBlock(row) { return `<iframe class="map-frame" title="打卡位置地图" loading="lazy" referrerpolicy="no-referrer" src="${C.mapEmbed(row)}"></iframe><a class="button-link secondary-button" target="_blank" rel="noopener noreferrer" href="${C.mapLink(row)}">在地图中打开</a>`; }
  function punch(title, row, teacher) {
    if (!row) return `<article class="punch-record"><h3>${title}</h3><div class="empty-copy">没有该次打卡</div></article>`;
    return `<article class="punch-record"><h3>${title}</h3><div class="punch-record-layout"><div data-attendance-photo="${C.escapeHtml(row.id)}"></div><div class="punch-record-location"><dl class="punch-meta"><dt>老师</dt><dd>${C.escapeHtml(teacher.teacherName)}</dd><dt>电话</dt><dd>${C.escapeHtml(teacher.phone)}</dd><dt>完整时间</dt><dd>${time(row)}</dd><dt>附近地点</dt><dd>${C.escapeHtml(row.placeName || "未解析")}</dd><dt>具体地址</dt><dd>${C.escapeHtml(row.formattedAddress || "暂无文字地址")}</dd></dl>${mapBlock(row)}</div></div></article>`;
  }
  function openDetail(id, kind) {
    const teacher = state.teachers.get(String(id));
    if (!teacher) return;
    $("attendanceDialogTitle").textContent = `${teacher.teacherName || "老师"}的${kind === "clockOut" ? "下班" : "上班"}打卡`;
    $("attendanceDialogMeta").textContent = `${state.date} · ${teacher.phone || "未登记"}`;
    $("attendanceDialogBody").innerHTML = kind === "clockOut" ? punch("下班打卡", teacher.clockOut, teacher) : punch("上班打卡", teacher.clockIn, teacher);
    $("attendanceTrackingDialog").showModal();
  }
  const exportController=window.QueryReportExport.mount({kind:"ATTENDANCE",readPayload:()=>({attendanceDate:state.date}),fetch:p=>C.call("staffAccount","getHqAttendanceTrackingDay",p),notice:(t)=>{$("attendanceTrackingMessage").textContent=t;}});
  async function load(date) {
    if (state.loading) return;
    exportController.begin(); state.loading = true; datePicker.busy(true); $("trackingAttendanceConfirm").disabled = true;
    $("attendanceTrackingMessage").textContent = "正在读取打卡追踪…";
    try {
      const result = await C.call("staffAccount", "getHqAttendanceTrackingDay", { attendanceDate: date });
      state.date = result.attendanceDate; state.serverToday = result.serverToday; exportController.commit({attendanceDate:state.date});
      $("trackingAttendanceDate").value = state.date; $("trackingAttendanceDate").max = state.serverToday; $("trackingAttendanceDate").syncChineseDate?.();
      datePicker.set(state.date, state.serverToday);
      render(result); $("attendanceTrackingMessage").textContent = "";
      history.replaceState(null, "", `attendance-tracking.html?date=${encodeURIComponent(state.date)}`);
    } catch (error) { $("attendanceTrackingMessage").textContent = error.message || "打卡追踪读取失败。"; render({ attendanceDate: date, completed: [], clockInOnly: [], clockOutOnly: [], missing: [] }); }
    finally { state.loading = false; datePicker.busy(false); $("trackingAttendanceConfirm").disabled = false; }
  }
  $("trackingAttendanceConfirm").addEventListener("click", () => { const date = datePicker.value(); if (date && (!state.serverToday || date <= state.serverToday)) load(date); });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const requested = new URLSearchParams(location.search).get("date") || today;
  $("attendanceTrackingGroups").addEventListener("click", event => { const button = event.target.closest("[data-teacher]"); if (button) openDetail(button.dataset.teacher, button.dataset.kind); });
  datePicker = window.WebTrackingUI.dateSelector($("attendanceTrackingDateParts"), today, today);
  load(/^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : today);
})();

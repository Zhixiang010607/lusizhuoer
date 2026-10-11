(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const C = window.WebWorkCommon;
  const state = { date: "", serverToday: "", teachers: new Map() };
  const groups = [
    ["completed", "完整打卡", "所选日期暂无完整打卡老师"],
    ["clockInOnly", "仅上班打卡", "所选日期暂无仅上班打卡老师"],
    ["clockOutOnly", "仅下班打卡", "所选日期暂无仅下班打卡老师"],
    ["missing", "未打卡", "全部在职老师均已有打卡记录"]
  ];
  const time = (row) => row ? `${C.shanghaiDateTime(row.checkedInAt)}（北京时间）` : "—";
  function detailButton(teacher, kind) { return teacher[kind] ? `<button class="tracking-detail-button secondary-button" type="button" data-teacher="${teacher.teacherId}" data-kind="${kind}">查看详情</button>` : "—"; }
  function table(items, empty) {
    if (!items.length) return `<div class="empty-copy">${empty}</div>`;
    return `<div class="table-scroll"><table class="tracking-table"><thead><tr><th>老师姓名</th><th>老师电话</th><th>上班时间</th><th>上班详情</th><th>下班时间</th><th>下班详情</th><th>工作时长</th></tr></thead><tbody>${items.map((teacher) => `<tr><td><a href="staff-detail.html?role=teacher&id=${encodeURIComponent(teacher.teacherId)}">${C.escapeHtml(teacher.teacherName || "未命名老师")}</a></td><td>${C.escapeHtml(teacher.phone || "未登记")}</td><td>${time(teacher.clockIn)}</td><td>${detailButton(teacher, "clockIn")}</td><td>${time(teacher.clockOut)}</td><td>${detailButton(teacher, "clockOut")}</td><td>${teacher.clockIn && teacher.clockOut ? C.duration(teacher.workDurationSeconds) : "—"}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function render(result) {
    state.teachers.clear();
    groups.forEach(([key]) => (result[key] || []).forEach((teacher) => state.teachers.set(String(teacher.teacherId), teacher)));
    $("attendanceTrackingTitle").textContent = `${result.attendanceDate} · 在职老师考勤`;
    $("attendanceTrackingSummary").innerHTML = groups.map(([key, label]) => `<span>${label} ${(result[key] || []).length}</span>`).join("");
    $("attendanceTrackingGroups").innerHTML = groups.map(([key, label, empty]) => `<section class="panel tracking-group"><div class="panel-heading"><div><h2>${label}</h2></div><span class="badge">${(result[key] || []).length} 人</span></div>${table(result[key] || [], empty)}</section>`).join("");
    $("attendanceTrackingGroups").querySelectorAll("[data-teacher]").forEach((button) => button.addEventListener("click", () => openDetail(button.dataset.teacher, button.dataset.kind)));
  }
  function mapBlock(row) { return `<iframe class="map-frame" title="打卡位置地图" loading="lazy" referrerpolicy="no-referrer" src="${C.mapEmbed(row)}"></iframe><a class="button-link secondary-button" target="_blank" rel="noopener noreferrer" href="${C.mapLink(row)}">在地图中打开</a>`; }
  function punch(title, row, teacher) {
    if (!row) return `<article class="punch-record"><h3>${title}</h3><div class="empty-copy">没有该次打卡</div></article>`;
    return `<article class="punch-record"><h3>${title}</h3><dl class="punch-meta"><dt>老师</dt><dd>${C.escapeHtml(teacher.teacherName)}</dd><dt>电话</dt><dd>${C.escapeHtml(teacher.phone)}</dd><dt>完整时间</dt><dd>${time(row)}</dd><dt>附近地点</dt><dd>${C.escapeHtml(row.placeName || "未解析")}</dd><dt>具体地址</dt><dd>${C.escapeHtml(row.formattedAddress || "暂无文字地址")}</dd><dt>经纬度</dt><dd>${Number(row.latitude).toFixed(6)}, ${Number(row.longitude).toFixed(6)}</dd><dt>定位精度</dt><dd>约 ${C.escapeHtml(row.accuracy)} 米</dd></dl>${mapBlock(row)}</article>`;
  }
  function openDetail(id, kind) {
    const teacher = state.teachers.get(String(id));
    if (!teacher) return;
    $("attendanceDialogTitle").textContent = `${teacher.teacherName || "老师"}的${kind === "clockOut" ? "下班" : "上班"}打卡`;
    $("attendanceDialogMeta").textContent = `${state.date} · ${teacher.phone || "未登记"}`;
    $("attendanceDialogBody").innerHTML = `${punch("上班打卡", teacher.clockIn, teacher)}${punch("下班打卡", teacher.clockOut, teacher)}`;
    $("attendanceTrackingDialog").showModal();
  }
  async function load(date) {
    $("attendanceTrackingMessage").textContent = "正在读取打卡追踪…";
    try {
      const result = await C.call("staffAccount", "getHqAttendanceTrackingDay", { attendanceDate: date });
      state.date = result.attendanceDate; state.serverToday = result.serverToday;
      $("trackingAttendanceDate").value = state.date; $("trackingAttendanceDate").max = state.serverToday; $("trackingAttendanceDate").syncChineseDate?.();
      render(result); $("attendanceTrackingMessage").textContent = "";
      history.replaceState(null, "", `attendance-tracking.html?date=${encodeURIComponent(state.date)}`);
    } catch (error) { $("attendanceTrackingMessage").textContent = error.message || "打卡追踪读取失败。"; render({ attendanceDate: date, completed: [], clockInOnly: [], clockOutOnly: [], missing: [] }); }
  }
  $("trackingAttendanceConfirm").addEventListener("click", () => { const date = $("trackingAttendanceDate").value; if (date && (!state.serverToday || date <= state.serverToday)) load(date); });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const requested = new URLSearchParams(location.search).get("date") || today;
  load(/^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= today ? requested : today);
})();

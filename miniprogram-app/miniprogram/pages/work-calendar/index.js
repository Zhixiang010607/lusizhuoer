const { callStaff } = require("../../services/api");
const { waitForStartupSession, requireSession } = require("../../services/session");
const { formatShanghaiTimestamp } = require("../../services/business-time");

function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function currentMonth() { const date = new Date(Date.now() + 8 * 3600000); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function shiftMonth(month, delta) { const [year, number] = month.split("-").map(Number), date = new Date(Date.UTC(year, number - 1 + delta, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function monthTitle(month) { const [year, number] = month.split("-"); return `${year}年${Number(number)}月`; }
function navigation(month, maximum) { return { canNextMonth: shiftMonth(month, 1) <= maximum, canNextYear: shiftMonth(month, 12) <= maximum, monthPickerEnd: maximum }; }
function durationText(clockIn, clockOut) { if (!clockIn || !clockOut) return "尚未形成完整工时"; const seconds = Math.max(0, (new Date(clockOut.checkedInAt).getTime() - new Date(clockIn.checkedInAt).getTime()) / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60); return `${hours} 小时 ${minutes} 分钟`; }
function recordView(record) { return record ? { ...record, timeText: formatShanghaiTimestamp(record.checkedInAt) } : null; }
function calendarCells(month, serverToday, employmentStartDate, attendance, reports) {
  const [year, number] = month.split("-").map(Number), offset = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7, total = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const attendanceByDate = new Map();
  (attendance || []).forEach((record) => { const date = text(record.attendanceDate); if (!attendanceByDate.has(date)) attendanceByDate.set(date, {}); attendanceByDate.get(date)[text(record.attendanceType)] = record; });
  const reportByDate = new Map((reports || []).map((report) => [text(report.reportDate), report]));
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const day = index - offset + 1;
    if (day < 1 || day > total) { cells.push({ key: `blank-${index}`, blank: true }); continue; }
    const date = `${month}-${String(day).padStart(2, "0")}`, future = date > serverToday, notEmployed = Boolean(employmentStartDate && date < employmentStartDate), records = attendanceByDate.get(date) || {}, report = reportByDate.get(date) || null;
    cells.push({ key: date, date, day, future, notEmployed, clockIn: records.CLOCK_IN || null, clockOut: records.CLOCK_OUT || null, report, clockInState: records.CLOCK_IN ? "done" : notEmployed ? "not-employed" : future ? "future" : "missing", clockOutState: records.CLOCK_OUT ? "done" : notEmployed ? "not-employed" : future ? "future" : "missing", reportState: report ? "done" : notEmployed ? "not-employed" : future ? "future" : "missing" });
  }
  return cells;
}
function selectedDay(cell) { if (!cell || cell.blank) return null; const clockIn = recordView(cell.clockIn), clockOut = recordView(cell.clockOut); return { date: cell.date, future: cell.future, notEmployed: cell.notEmployed, clockIn, clockOut, workDurationText: durationText(clockIn, clockOut), report: cell.report || null }; }

Page({
  data: { authorized: false, loading: true, mode: "attendance", month: currentMonth(), monthTitle: monthTitle(currentMonth()), ...navigation(currentMonth(), currentMonth()), weekdays: ["一", "二", "三", "四", "五", "六", "日"], days: [], selectedDate: "", selected: null, teacher: {}, serverToday: "", employmentStartDate: "", message: "", error: false },
  async onLoad(options = {}) { this._unloaded = false; const mode = text(options.mode); if (["attendance", "report"].includes(mode)) this.setData({ mode }); await waitForStartupSession(); if (this._unloaded || !requireSession(["teacher"])) return; this.setData({ authorized: true }); await this.loadMonth(this.data.month); },
  onShow() { if (!this._shownOnce) { this._shownOnce = true; return; } if (this.data.authorized && !this.data.loading) this.loadMonth(this.data.month); },
  onUnload() { this._unloaded = true; this._epoch = Number(this._epoch || 0) + 1; },
  onPullDownRefresh() { this.loadMonth(this.data.month).finally(() => wx.stopPullDownRefresh()); },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({ url: "/pages/home/index" }); },
  switchMode(event) { const mode = text(event.currentTarget.dataset.mode); if (["attendance", "report"].includes(mode)) this.setData({ mode }); },
  async loadMonth(month) {
    const epoch = this._epoch = Number(this._epoch || 0) + 1;
    this.setData({ loading: true, message: "正在读取工作月历…", error: false });
    try {
      const result = await callStaff("getOwnTeacherWorkMonth", { month });
      if (this._unloaded || epoch !== this._epoch) return;
      const serverToday = text(result.serverToday), maximum = serverToday.slice(0, 7) || currentMonth(), employmentStartDate = text(result.teacher?.employmentStartDate), days = calendarCells(month, serverToday, employmentStartDate, result.attendance, result.reports), preferred = this.data.selectedDate.startsWith(`${month}-`) ? this.data.selectedDate : serverToday.startsWith(`${month}-`) ? serverToday : `${month}-01`, cell = days.find((item) => item.date === preferred) || days.find((item) => !item.blank);
      this.setData({ month, monthTitle: monthTitle(month), ...navigation(month, maximum), days, selectedDate: cell?.date || "", selected: selectedDay(cell), teacher: result.teacher || {}, serverToday, employmentStartDate, message: "", error: false });
    } catch (error) { if (!this._unloaded && epoch === this._epoch) this.setData({ days: [], selected: null, message: error.message || "工作月历读取失败", error: true }); }
    finally { if (!this._unloaded && epoch === this._epoch) this.setData({ loading: false }); }
  },
  changeMonth(event) { if (this.data.loading) return; const month = shiftMonth(this.data.month, Number(event.currentTarget.dataset.delta || 0)); if (month <= this.data.monthPickerEnd) this.loadMonth(month); },
  chooseMonth(event) { if (this.data.loading) return; const month = text(event.detail?.value).slice(0, 7); if (/^\d{4}-\d{2}$/.test(month) && month <= this.data.monthPickerEnd) this.loadMonth(month); },
  selectDate(event) { const date = text(event.currentTarget.dataset.date), cell = this.data.days.find((item) => item.date === date); if (cell && !cell.blank) this.setData({ selectedDate: date, selected: selectedDay(cell) }); },
  openMap(event) { const kind = text(event.currentTarget.dataset.kind), record = this.data.selected?.[kind], latitude = Number(record?.latitude), longitude = Number(record?.longitude); if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return; wx.openLocation({ latitude, longitude, scale: 18, name: text(record.placeName) || `${kind === "clockIn" ? "上班" : "下班"}打卡位置`, address: text(record.formattedAddress) || `${latitude}, ${longitude}` }); },
  openAttendance() { wx.navigateTo({ url: "/pages/attendance/index" }); },
  openDailyReport() { wx.navigateTo({ url: "/pages/daily-report/index" }); }
});

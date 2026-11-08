const { requireTeamAccess, teacherUrl } = require("../../services/teacher-team");
const { callStaff } = require("../../services/api");
const { waitForStartupSession, requireSession } = require("../../services/session");
const { formatShanghaiTimestamp } = require("../../services/business-time");

function pad(value) { return String(value).padStart(2, "0"); }
function localShanghaiDate() { const date = new Date(Date.now() + 8 * 60 * 60 * 1000); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; }
function monthShift(month, amount) { const [year, number] = String(month).split("-").map(Number); const date = new Date(Date.UTC(year, number - 1 + amount, 1)); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`; }
function calendarCells(month, selectedDate, serverToday) {
  const [year, number] = String(month).split("-").map(Number);
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const blanks = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: blanks }, (_, index) => ({ key: `blank-${index}`, blank: true }));
  for (let day = 1; day <= days; day += 1) { const date = `${month}-${pad(day)}`; cells.push({ key: date, day, date, selected: date === selectedDate, today: date === serverToday, future: date > serverToday }); }
  return cells;
}
function submittedAt(row = {}) {
  if (!row.completed) return "—";
  const value = formatShanghaiTimestamp(row.updatedAt || row.updated_at);
  const match = value.match(/(\d{2}:\d{2})(?::\d{2})?$/);
  return match ? match[1] : "—";
}
function teacher(row = {}) { return { teacherId: String(row.teacherId || ""), teacherCode: String(row.teacherCode || ""), teacherName: String(row.teacherName || "未命名老师"), phone: String(row.phone || "未登记"), reportId: String(row.reportId || ""), completed: Boolean(row.completed), submittedAt: submittedAt(row) }; }
function reportSections(report = {}) {
  return [
    { label: "提交时间", value: formatShanghaiTimestamp(report.updatedAt || report.updated_at) || "—" },
    { label: "今日完成事项", value: String(report.completedWork || "未填写") }
  ];
}

Page({
  exportFile(event) {
    if (!this._exportPayload) return;
    const snapshot = JSON.stringify(this._exportPayload), epoch = this._requestEpoch ?? this._epoch ?? this._dayEpoch;
    return require("../../services/query-report-export").exportPage(this, "DAILY_REPORT", {...this._exportPayload}, {team:this.data.teamScope === true,format:event.currentTarget.dataset.format,valid:()=>snapshot === JSON.stringify(this._exportPayload) && epoch === (this._requestEpoch ?? this._epoch ?? this._dayEpoch)});
  },
  data: { exporting:false, exportReady:false, teamScope:false, authorized: false, loading: true, detailLoading: false, serverToday: "", visibleMonth: "", selectedDate: "", pendingDate: "", canNextMonth: false, calendarCells: [], completed: [], incomplete: [], message: "", error: false, detailOpen: false, detailTeacher: {}, detailSections: [] },
  async onLoad(options = {}) {
    this._unloaded = false;
    const today = localShanghaiDate();
    this.setData({ serverToday: today, visibleMonth: today.slice(0, 7), selectedDate: today, pendingDate: today, calendarCells: calendarCells(today.slice(0, 7), today, today) });
    await waitForStartupSession();
    if (this._unloaded) return;
    if(options.scope === "TEAM") { this.setData({teamScope:true});try{await requireTeamAccess();}catch(error){if(!this._unloaded)this.setData({loading:false,message:error.message,error:true});return;} } else { if (!requireSession(["hq"])) return; }
    if(this._unloaded)return;
    this.setData({ authorized: true });
    await this.loadDay(today); this._teamMounted=true;
  },
  onShow(){if(this.data.teamScope && this._teamMounted){this.setData({authorized:true});this.loadDay(this.data.selectedDate);}},
  onUnload() { this._unloaded = true; this._dayEpoch = (this._dayEpoch || 0) + 1; this._detailEpoch = (this._detailEpoch || 0) + 1; },
  onPullDownRefresh() { this.loadDay(this.data.selectedDate).finally(() => wx.stopPullDownRefresh()); },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({ url: "/pages/home/index" }); },
  async loadDay(reportDate) {
    if (!this.data.authorized || this._unloaded) return;
    this._exportPayload = null; this.setData({exportReady:false}); const epoch = this._dayEpoch = (this._dayEpoch || 0) + 1;
    this.setData({ loading: true, completed: [], incomplete: [], message: "正在读取日报完成情况…", error: false, detailOpen: false });
    try {
      const result = this.data.teamScope ? await callStaff("getTeamDailyReportTrackingDay", { reportDate }) : await callStaff("getHqDailyReportTrackingDay", { reportDate });
      if (this._unloaded || epoch !== this._dayEpoch) return;
      const serverToday = String(result.serverToday || this.data.serverToday);
      const selectedDate = String(result.reportDate || reportDate);
      const visibleMonth = selectedDate.slice(0, 7);
      this._exportPayload = { reportDate: selectedDate }; this.setData({exportReady:true}); this.setData({ serverToday, selectedDate, pendingDate: selectedDate, visibleMonth, canNextMonth: monthShift(visibleMonth, 1) <= serverToday.slice(0, 7), calendarCells: calendarCells(visibleMonth, selectedDate, serverToday), completed: (result.completed || []).map(teacher), incomplete: (result.incomplete || []).map(teacher), message: "", error: false });
    } catch (error) { if (!this._unloaded && epoch === this._dayEpoch) this.setData({ message: error.message || "日报追踪读取失败", error: true, ...(this.data.teamScope?{authorized:false,completed:[],incomplete:[],detailOpen:false,detailTeacher:{},detailSections:[]}:{}) }); }
    finally { if (!this._unloaded && epoch === this._dayEpoch) this.setData({ loading: false }); }
  },
  selectDate(event) { const date = String(event.currentTarget.dataset.date || ""); if (date && date <= this.data.serverToday && !this.data.loading) return this.loadDay(date); },
  previousMonth() { if (this.data.loading) return; const visibleMonth = monthShift(this.data.visibleMonth, -1); const selectedDate = `${visibleMonth}-01`; this.setData({ visibleMonth, selectedDate, calendarCells: calendarCells(visibleMonth, selectedDate, this.data.serverToday) }); return this.loadDay(selectedDate); },
  nextMonth() { if (this.data.loading) return; const visibleMonth = monthShift(this.data.visibleMonth, 1); if (visibleMonth > this.data.serverToday.slice(0, 7)) return; const selectedDate = visibleMonth === this.data.serverToday.slice(0, 7) ? this.data.serverToday : `${visibleMonth}-01`; this.setData({ visibleMonth, selectedDate, calendarCells: calendarCells(visibleMonth, selectedDate, this.data.serverToday) }); return this.loadDay(selectedDate); },
  chooseMonth(event) { const month = String(event.detail.value || "").slice(0, 7); if (!/^\d{4}-\d{2}$/.test(month) || month > this.data.serverToday.slice(0, 7)) return; const date = month === this.data.serverToday.slice(0, 7) ? this.data.serverToday : `${month}-01`; return this.loadDay(date); },
  chooseDate(event) { const date = String(event.detail.value || ""); if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= this.data.serverToday) this.setData({ pendingDate: date }); },
  confirmDate() { const date = String(this.data.pendingDate || ""); if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= this.data.serverToday && !this.data.loading) return this.loadDay(date); },
  today() { if (!this.data.loading) return this.loadDay(this.data.serverToday); },
  openTeacher(event) { const teacherId = String(event.currentTarget.dataset.id || ""); if (teacherId) wx.navigateTo({ url: this.data.teamScope ? teacherUrl(teacherId) : `/pages/teacher-detail/index?teacherRef=${encodeURIComponent(teacherId)}` }); },
  async openReport(event) {
    const reportId = String(event.currentTarget.dataset.id || "");
    if (!reportId || this.data.detailLoading) return;
    const epoch = this._detailEpoch = (this._detailEpoch || 0) + 1;
    this.setData({ detailLoading: true, message: "正在读取日报内容…", error: false });
    try {
      const result = this.data.teamScope ? await callStaff("getTeamDailyReportDetail", { reportId }) : await callStaff("getHqDailyReportDetail", { reportId });
      if (this._unloaded || epoch !== this._detailEpoch) return;
      this.setData({ detailOpen: true, detailTeacher: teacher(result.teacher), detailSections: reportSections(result.report), message: "", error: false });
    } catch (error) { if (!this._unloaded && epoch === this._detailEpoch) this.setData({ message: error.message || "日报详情读取失败", error: true, ...(this.data.teamScope?{authorized:false,completed:[],incomplete:[],detailOpen:false,detailTeacher:{},detailSections:[]}:{}) }); }
    finally { if (!this._unloaded && epoch === this._detailEpoch) this.setData({ detailLoading: false }); }
  },
  closeDetail() { if (!this.data.detailLoading) this.setData({ detailOpen: false, detailTeacher: {}, detailSections: [] }); },
  noop() {}
});

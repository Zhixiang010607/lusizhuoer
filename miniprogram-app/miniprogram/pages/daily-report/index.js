const { callStaff } = require("../../services/api");
const { waitForStartupSession, requireSession } = require("../../services/session");

const MAX_LENGTH = 200;
const FIELDS = Object.freeze(["completedWork", "customerProjectProgress", "problemsAndSupport", "tomorrowPlan"]);
const FIELD_LABELS = Object.freeze({
  completedWork: "今日完成事项",
  customerProjectProgress: "客户或项目进展",
  problemsAndSupport: "遇到的问题",
  tomorrowPlan: "明日计划"
});

function pad(value) { return String(value).padStart(2, "0"); }
function localShanghaiDate() {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function monthShift(month, amount) {
  const [year, number] = String(month).split("-").map(Number);
  const date = new Date(Date.UTC(year, number - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}
function calendarCells(month, selectedDate, serverToday, reportDates = []) {
  const [year, number] = String(month).split("-").map(Number);
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const blanks = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
  const reports = new Set(reportDates);
  const cells = Array.from({ length: blanks }, (_, index) => ({ key: `blank-${index}`, blank: true }));
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${pad(day)}`;
    cells.push({
      key: date, day, date, blank: false,
      selected: date === selectedDate,
      today: date === serverToday,
      future: Boolean(serverToday && date > serverToday),
      completed: reports.has(date)
    });
  }
  return cells;
}
function reportValues(report = {}) {
  return Object.fromEntries(FIELDS.map((field) => [field, String(report?.[field] || "")]));
}

Page({
  data: {
    authorized: false, loadingMonth: true, loadingReport: false, saving: false,
    message: "", error: false, serverToday: "", visibleMonth: "", selectedDate: "", pendingDate: "", canNextMonth: false, calendarCells: [],
    editable: false, editing: false, future: false, reportExists: false,
    completedWork: "", customerProjectProgress: "", problemsAndSupport: "", tomorrowPlan: "",
    completedWorkCount: 0, customerProjectProgressCount: 0, problemsAndSupportCount: 0, tomorrowPlanCount: 0
  },
  async onLoad() {
    this._unloaded = false;
    const today = localShanghaiDate();
    this.setData({ serverToday: today, visibleMonth: today.slice(0, 7), selectedDate: today, pendingDate: today });
    await waitForStartupSession();
    if (this._unloaded) return;
    if (!requireSession(["teacher"])) return;
    this.setData({ authorized: true });
    await this.loadMonth(today.slice(0, 7), today);
  },
  onUnload() { this._unloaded = true; this._monthEpoch = (this._monthEpoch || 0) + 1; this._reportEpoch = (this._reportEpoch || 0) + 1; },
  onPullDownRefresh() { this.loadMonth(this.data.visibleMonth, this.data.selectedDate).finally(() => wx.stopPullDownRefresh()); },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({ url: "/pages/home/index" }); },
  renderCalendar(reportDates = this._reportDates || []) {
    this._reportDates = reportDates;
    this.setData({ calendarCells: calendarCells(this.data.visibleMonth, this.data.selectedDate, this.data.serverToday, reportDates) });
  },
  async loadMonth(month, preferredDate = "") {
    if (!this.data.authorized || this._unloaded) return;
    const epoch = this._monthEpoch = (this._monthEpoch || 0) + 1;
    this._reportEpoch = (this._reportEpoch || 0) + 1;
    this.setData({ loadingMonth: true, loadingReport: false, message: "正在读取日报日历…", error: false });
    try {
      const result = await callStaff("getOwnDailyReportMonth", { month });
      if (this._unloaded || epoch !== this._monthEpoch) return;
      const serverToday = String(result.serverToday || localShanghaiDate());
      const visibleMonth = String(result.month || month);
      let selectedDate = preferredDate && preferredDate.startsWith(visibleMonth) ? preferredDate : visibleMonth === serverToday.slice(0, 7) ? serverToday : `${visibleMonth}-01`;
      if (selectedDate > serverToday) selectedDate = serverToday;
      const reportDates = (result.reports || []).map((item) => String(item.reportDate || "")).filter(Boolean);
      this._reportDates = reportDates;
      this.setData({ serverToday, visibleMonth, selectedDate, pendingDate: selectedDate, canNextMonth: monthShift(visibleMonth, 1) <= serverToday.slice(0, 7), message: "", calendarCells: calendarCells(visibleMonth, selectedDate, serverToday, reportDates) });
      await this.loadReport(selectedDate);
    } catch (error) {
      if (this._unloaded || epoch !== this._monthEpoch) return;
      this.setData({ message: error.message || "日报日历读取失败", error: true, editable: false });
    } finally { if (!this._unloaded && epoch === this._monthEpoch) this.setData({ loadingMonth: false }); }
  },
  async loadReport(reportDate) {
    const epoch = this._reportEpoch = (this._reportEpoch || 0) + 1;
    this.setData({ loadingReport: true, message: "正在读取日报…", error: false });
    try {
      const result = await callStaff("getOwnDailyReport", { reportDate });
      if (this._unloaded || epoch !== this._reportEpoch || reportDate !== this.data.selectedDate) return;
      const values = reportValues(result.report);
      const counts = Object.fromEntries(FIELDS.map((field) => [`${field}Count`, Array.from(values[field]).length]));
      this.setData({
        ...values, ...counts, serverToday: String(result.serverToday || this.data.serverToday),
        editable: Boolean(result.editable), editing: Boolean(result.editable) && !result.report, future: Boolean(result.future), reportExists: Boolean(result.report),
        canNextMonth: monthShift(this.data.visibleMonth, 1) <= String(result.serverToday || this.data.serverToday).slice(0, 7),
        message: result.future ? "未来日期不能提前填写日报。" : !result.report && !result.editable ? "这一天没有填写日报。" : "", error: false
      });
      this.renderCalendar();
    } catch (error) {
      if (this._unloaded || epoch !== this._reportEpoch) return;
      this.setData({ ...reportValues(), editable: false, reportExists: false, message: error.message || "日报读取失败", error: true });
    } finally { if (!this._unloaded && epoch === this._reportEpoch) this.setData({ loadingReport: false }); }
  },
  selectDate(event) {
    const date = String(event.currentTarget.dataset.date || "");
    if (!date || date > this.data.serverToday || this.data.loadingMonth || this.data.saving) return;
    this.setData({ selectedDate: date });
    this.renderCalendar();
    return this.loadReport(date);
  },
  previousMonth() { if (!this.data.loadingMonth && !this.data.saving) return this.loadMonth(monthShift(this.data.visibleMonth, -1)); },
  nextMonth() {
    const next = monthShift(this.data.visibleMonth, 1);
    if (!this.data.loadingMonth && !this.data.saving && next <= this.data.serverToday.slice(0, 7)) return this.loadMonth(next);
  },
  chooseMonth(event) {
    const month = String(event.detail.value || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month) && month <= this.data.serverToday.slice(0, 7)) return this.loadMonth(month);
  },
  chooseDate(event) {
    const date = String(event.detail.value || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= this.data.serverToday && !this.data.saving) this.setData({ pendingDate: date });
  },
  confirmDate() {
    const date = String(this.data.pendingDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > this.data.serverToday || this.data.loadingMonth || this.data.saving) return;
    if (date.slice(0, 7) !== this.data.visibleMonth) return this.loadMonth(date.slice(0, 7), date);
    this.setData({ selectedDate: date });
    return this.loadReport(date);
  },
  today() { if (!this.data.loadingMonth && !this.data.saving) return this.loadMonth(this.data.serverToday.slice(0, 7), this.data.serverToday); },
  inputField(event) {
    const field = String(event.currentTarget.dataset.field || "");
    if (!FIELDS.includes(field) || !this.data.editable || !this.data.editing) return;
    const value = String(event.detail.value || "");
    this.setData({ [field]: value, [`${field}Count`]: Array.from(value).length });
  },
  edit() {
    if (this.data.editable && this.data.reportExists && !this.data.saving) this.setData({ editing: true, message: "正在编辑今日日报，修改后请点击确认提交。", error: false });
  },
  async save() {
    if (!this.data.editable || !this.data.editing || this.data.selectedDate !== this.data.serverToday || this.data.saving) return;
    const payload = { reportDate: this.data.selectedDate };
    FIELDS.forEach((field) => { payload[field] = String(this.data[field] || "").trim(); });
    const missingField = FIELDS.find((field) => !payload[field]);
    if (missingField) return this.setData({ message: `请填写${FIELD_LABELS[missingField]}。`, error: true });
    if (FIELDS.some((field) => Array.from(payload[field]).length > MAX_LENGTH)) return this.setData({ message: `每项内容不能超过 ${MAX_LENGTH} 个字符。`, error: true });
    this.setData({ saving: true, message: "正在保存…", error: false });
    try {
      const result = await callStaff("saveOwnDailyReport", payload);
      if (this._unloaded) return;
      const values = reportValues(result.report);
      const counts = Object.fromEntries(FIELDS.map((field) => [`${field}Count`, Array.from(values[field]).length]));
      const reportDates = [...new Set([...(this._reportDates || []), this.data.selectedDate])];
      this._reportDates = reportDates;
      this.setData({ ...values, ...counts, reportExists: true, editing: false, message: "今日日报已提交；当天可点击编辑继续修改。", error: false, calendarCells: calendarCells(this.data.visibleMonth, this.data.selectedDate, this.data.serverToday, reportDates) });
    } catch (error) { if (!this._unloaded) this.setData({ message: error.message || "日报保存失败", error: true }); }
    finally { if (!this._unloaded) this.setData({ saving: false }); }
  }
});

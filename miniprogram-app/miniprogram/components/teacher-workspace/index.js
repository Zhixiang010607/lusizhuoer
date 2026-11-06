const { callFace } = require("../../services/api");
const dashboard = require("../../services/home-dashboard");
const PAGE_SIZE = 10;
function pageView(value = {}) {
  const page = dashboard.pageState(value);
  return { ...page, previousDisabled: page.page <= 1, nextDisabled: page.page >= page.totalPages };
}
function emptyResults() {
  return { rows: [], summaryRows: [], totals: { ...dashboard.EMPTY_TOTALS }, page: pageView(), pageInput: "1", visibleRows: 0, viewportHeight: 64, tableHeight: 0 };
}
Component({
  properties: {
    teacherId: { type: String, value: "" }, teacherName: { type: String, value: "" },
    teacherPhone: { type: String, value: "" }, balances: { type: Array, value: [] }, viewerMode:{type:String,value:"HQ"}
  },
  data: {
    ...emptyResults(), rangePreset: "TODAY", rangeOptions: dashboard.RANGE_OPTIONS.slice(0, 3),
    moreOptions: dashboard.RANGE_OPTIONS.slice(3), moreIndex: 0, moreLabel: "更多", customVisible: false,
    startDate: "", endDate: "", rangeLabel: "今天", businessType: "VERIFICATION",
    businessTabs: dashboard.tabs({}, "VERIFICATION"), loading: false, error: ""
  },
  observers: { teacherId() { if (this._ready) this.resetTeacher(); } },
  lifetimes: {
    attached() { this._ready = true; this.resetTeacher(); },
    detached() { this._ready = false; this._epoch = (this._epoch || 0) + 1; }
  },
  pageLifetimes: { show() { if (this._ready && this._loadedOnce && !this.data.loading) this.load(this.data.page.page); }, resize() { this.measureTable(); } },
  methods: {
    resetTeacher() {
      this._epoch = (this._epoch || 0) + 1;
      this._loadedOnce = false;
      this.setData({ ...emptyResults(), rangePreset: "TODAY", businessType: "VERIFICATION", businessTabs: dashboard.tabs({}, "VERIFICATION"), customVisible: false, moreIndex: 0, moreLabel: "更多", error: "" });
      if (this.data.teacherId) return this.load(1);
    },
    async load(page = 1) {
      if (!this._ready || !/^\d+$/.test(this.data.teacherId)) return;
      const range = dashboard.scopedRange(this.data.rangePreset, { startDate: this.data.startDate, endDate: this.data.endDate });
      if (this.data.rangePreset === "CUSTOM" && (!range.startDate || !range.endDate || range.startDate > range.endDate || dashboard.rangeDays(range.startDate, range.endDate) > 366 || range.endDate > dashboard.today())) {
        this.setData({ error: "请选择完整日期，开始不能晚于结束，最多 366 天且不能选择未来日期" }); return;
      }
      const epoch = this._epoch = (this._epoch || 0) + 1;
      const request = Object.freeze({ teacherId: this.data.teacherId, recordType: this.data.businessType, page, pageSize: PAGE_SIZE, includeOverview: true, ...dashboard.payload(range.startDate, range.endDate) });
      this.setData({ loading: true, error: "", startDate: range.startDate, endDate: range.endDate });
      try {
        const result = await callFace(this.data.viewerMode === "TEAM" ? "getTeamTeacherWorkspace" : "getHqTeacherWorkspace", request);
        if (!this._ready || epoch !== this._epoch) return;
        if (String(result.profile?.teacherId || "") !== request.teacherId) throw new Error("老师资料不一致，请返回列表重试");
        const rows = dashboard.records(result.page?.records, request.recordType);
        const totals = dashboard.totals(result.summary?.totals);
        const currentPage = pageView(result.page);
        this.setData({ rows, totals, summaryRows: dashboard.products(result.summary?.products), page: currentPage, pageInput: String(currentPage.page), visibleRows: rows.length, viewportHeight: 64 + rows.length * 72, tableHeight: 0, businessTabs: dashboard.tabs(totals, request.recordType), rangeLabel: dashboard.periodLabel(this.data.rangePreset, range.startDate, range.endDate) }, () => this.measureTable());
      } catch (error) {
        if (!this._ready || epoch !== this._epoch) return;
        this.setData({ ...emptyResults(), businessTabs: dashboard.tabs({}, this.data.businessType), error: "老师业务读取失败，请重试" });
      } finally { if (this._ready && epoch === this._epoch) { this._loadedOnce = true; this.setData({ loading: false }); } }
    },
    measureTable() {
      if (!this._ready || !this.data.rows.length || typeof wx.nextTick !== "function") return;
      const epoch = this._epoch;
      wx.nextTick(() => {
        if (!this._ready || epoch !== this._epoch) return;
        this.createSelectorQuery().select(".record-table").boundingClientRect(rect => {
          if (this._ready && epoch === this._epoch && rect?.height > 0) this.setData({ tableHeight: Math.ceil(rect.height) });
        }).exec();
      });
    },
    chooseRange(event) {
      const preset = event.currentTarget.dataset.preset;
      if (!dashboard.RANGE_OPTIONS.some(item => item.value === preset)) return;
      // Invalidate an in-flight read even when custom dates still need input.
      this._epoch = (this._epoch || 0) + 1;
      this.setData({ rangePreset: preset, customVisible: preset === "CUSTOM", loading: false, error: "", ...emptyResults(), businessTabs: dashboard.tabs({}, this.data.businessType) });
      if (preset !== "CUSTOM") return this.load(1);
    },
    chooseMoreRange(event) {
      const index = Number(event.detail.value), option = this.data.moreOptions[index];
      if (!option) return;
      this.setData({ moreIndex: index, moreLabel: option.label });
      this.chooseRange({ currentTarget: { dataset: { preset: option.value } } });
    },
    changeDate(event) { if (["startDate", "endDate"].includes(event.currentTarget.dataset.field)) this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
    applyRange() { return this.load(1); }, retry() { return this.load(this.data.page.page); },
    selectType(event) {
      const type = event.currentTarget.dataset.type;
      if (!dashboard.TYPE_CONFIG[type] || type === this.data.businessType) return;
      this.setData({ businessType: type }); return this.load(1);
    },
    previousPage() { if (!this.data.loading && !this.data.page.previousDisabled) return this.load(this.data.page.page - 1); },
    nextPage() { if (!this.data.loading && !this.data.page.nextDisabled) return this.load(this.data.page.page + 1); },
    inputPage(event) { this.setData({ pageInput: event.detail.value }); },
    jumpPage() {
      const page = Number(this.data.pageInput);
      if (this.data.loading) return;
      if (!Number.isInteger(page) || page < 1 || page > this.data.page.totalPages) { this.setData({ error: "请输入有效页码" }); return; }
      return this.load(page);
    },
    openOrder(event) {
      if(this.data.viewerMode === "TEAM")return;
      const row = this.data.rows.find(item => item.id === String(event.currentTarget.dataset.id));
      if (!row) return;
      const type = ["RECHARGE", "REFUND"].includes(row.type) ? "RECHARGE" : "VERIFICATION";
      wx.navigateTo({ url: `/pages/order-detail/index?type=${type.toLowerCase()}&category=${row.type}&recordId=${encodeURIComponent(row.id)}&recordCode=${encodeURIComponent(row.recordCode)}` });
    },
    openCustomer(event) {
      if(this.data.viewerMode === "TEAM")return;
      const code = String(event.currentTarget.dataset.code || "");
      if (code) wx.navigateTo({ url: `/pages/customer-detail/index?customerCode=${encodeURIComponent(code)}` });
    }
  }
});

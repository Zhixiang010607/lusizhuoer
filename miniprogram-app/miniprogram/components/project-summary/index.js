Component({
  properties: {
    rows: { type: Array, value: [] },
    totals: { type: Object, value: {} },
    totalsReady: { type: Boolean, value: false },
    loading: { type: Boolean, value: true },
    error: { type: String, value: "" }
  },
  data: { tableHeight: 0 },
  observers: {
    "rows, totals, totalsReady, loading, error"() { this.measureTable(); }
  },
  lifetimes: {
    attached() { this._attached = true; this.measureTable(); },
    detached() { this._attached = false; this._measureEpoch = (this._measureEpoch || 0) + 1; }
  },
  pageLifetimes: { resize() { this.measureTable(); }, show() { this.measureTable(); } },
  methods: {
    measureTable() {
      if (!this._attached) return;
      const epoch = this._measureEpoch = (this._measureEpoch || 0) + 1;
      if (this.data.loading || this.data.error || !this.data.rows.length) {
        if (this.data.tableHeight) this.setData({ tableHeight: 0 });
        return;
      }
      wx.nextTick(() => {
        if (!this._attached || epoch !== this._measureEpoch) return;
        this.createSelectorQuery().select(".summary-table").boundingClientRect((rect) => {
          if (!this._attached || epoch !== this._measureEpoch || !rect || !(rect.height > 0)) return;
          const tableHeight = Math.ceil(rect.height);
          if (tableHeight !== this.data.tableHeight) this.setData({ tableHeight });
        }).exec();
      });
    },
    retry() { this.triggerEvent("retry"); }
  }
});

Component({
  properties: {
    stores: { type: Array, value: [], observer: "sync" },
    selectedId: { type: String, value: "", observer: "sync" },
    loading: { type: Boolean, value: false, observer: "sync" },
    disabled: { type: Boolean, value: false, observer: "sync" }
  },
  data: { keyword: "", expanded: false, matches: [], matchCount: 0, visibleLimit: 50, selectedName: "", tablet: false },
  lifetimes: { attached() { this.resize(); this.sync(); } },
  pageLifetimes: { resize(event) { this.resize(event); } },
  methods: {
    resize(event) {
      const size = event?.size || wx.getWindowInfo();
      this.setData({ tablet: Number(size.windowWidth) >= 700 });
    },
    sync() {
      const selected = (this.data.stores || []).find(store => String(store.id) === this.data.selectedId);
      const changes = { selectedName: selected?.name || "" };
      if (selected && !this._editing) changes.keyword = selected.name;
      if (this.data.loading || this.data.disabled) changes.expanded = false;
      this.setData(changes);
      this.filter();
    },
    filter() {
      const keyword = String(this.data.keyword || "").trim().toLowerCase();
      const matches = (this.data.stores || []).map((store, index) => {
        const name = String(store.name || ""), at = name.toLowerCase().indexOf(keyword);
        return { id: String(store.id || ""), name, code: String(store.code || ""), value: index + 1,
          before: keyword && at >= 0 ? name.slice(0, at) : name,
          match: keyword && at >= 0 ? name.slice(at, at + keyword.length) : "",
          after: keyword && at >= 0 ? name.slice(at + keyword.length) : "", at };
      }).filter(store => store.id && store.name && store.at >= 0);
      this.setData({ matches: matches.slice(0, this.data.visibleLimit), matchCount: matches.length });
    },
    focus() {
      if (this.data.disabled || this.data.loading) return;
      this.setData({ expanded: true });
      this.filter();
    },
    input(event) {
      if (this.data.disabled || this.data.loading) return;
      this._editing = true;
      this.setData({ keyword: event.detail.value, expanded: true, visibleLimit: 50 });
      if (this.data.selectedId) this.triggerEvent("change", { value: 0 });
      this.filter();
    },
    clear() { this.input({ detail: { value: "" } }); },
    toggle() {
      if (this.data.disabled || this.data.loading) return;
      this.setData({ expanded: !this.data.expanded });
      this.filter();
    },
    choose(event) {
      if (this.data.disabled || this.data.loading) return;
      const value = Number(event.currentTarget.dataset.value);
      const selected = this.data.matches.find(store => store.value === value);
      if (!selected) return;
      this._editing = false;
      this.setData({ keyword: selected.name, expanded: false });
      this.triggerEvent("change", { value });
    },
    more() {
      if (this.data.disabled || this.data.loading || !this.data.expanded) return;
      this.setData({ visibleLimit: this.data.visibleLimit + 50 });
      this.filter();
    }
  }
});

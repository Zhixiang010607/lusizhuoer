function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || "")); }
Component({
  properties: {
    value: { type: String, value: "", observer: "sync" },
    end: { type: String, value: "", observer: "sync" },
    disabled: { type: Boolean, value: false }
  },
  data: { years: [], months: [], yearIndex: 0, monthIndex: 0, year: "", month: "" },
  lifetimes: { attached() { this.sync(); } },
  methods: {
    sync() { this.apply(validMonth(this.data.value) ? this.data.value : this.maximum(), false); },
    maximum() { return validMonth(this.data.end) ? this.data.end : "2099-12"; },
    apply(value, emit) {
      if (!validMonth(value)) return;
      const maximum = this.maximum(), safe = value > maximum ? maximum : value;
      const [year, month] = safe.split("-"), endYear = Number(maximum.slice(0, 4));
      const firstYear = Math.min(1900, Number(year));
      const years = Array.from({ length: endYear - firstYear + 1 }, (_, i) => ({ value: String(firstYear + i), label: `${firstYear + i}年` }));
      const limit = Number(year) === endYear ? Number(maximum.slice(5, 7)) : 12;
      const months = Array.from({ length: limit }, (_, i) => ({ value: String(i + 1).padStart(2, "0"), label: `${i + 1}月` }));
      this.setData({ years, months, year, month, yearIndex: years.findIndex(item => item.value === year), monthIndex: Number(month) - 1 });
      if (emit && safe !== this.data.value) this.triggerEvent("change", { value: safe });
    },
    chooseYear(event) {
      if (this.data.disabled) return;
      const index = Number(event.detail.value), option = Number.isInteger(index) && this.data.years[index];
      if (option) this.apply(`${option.value}-${this.data.month}`, true);
    },
    chooseMonth(event) {
      if (this.data.disabled) return;
      const index = Number(event.detail.value), option = Number.isInteger(index) && this.data.months[index];
      if (option) this.apply(`${this.data.year}-${option.value}`, true);
    }
  }
});

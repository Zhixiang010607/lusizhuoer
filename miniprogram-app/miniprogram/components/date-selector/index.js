function pad(value) {
  return String(value).padStart(2, "0");
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

Component({
  properties: {
    value: { type: String, value: "", observer: "syncFromProperties" },
    end: { type: String, value: "", observer: "syncFromProperties" },
    disabled: { type: Boolean, value: false }
  },
  data: {
    years: [],
    months: [],
    days: [],
    yearIndex: 0,
    monthIndex: 0,
    dayIndex: 0,
    selectedYear: "",
    selectedMonth: "",
    selectedDay: ""
  },
  lifetimes: {
    attached() { this.syncFromProperties(); }
  },
  methods: {
    syncFromProperties() {
      const end = validDate(this.data.end) ? this.data.end : "2099-12-31";
      const raw = validDate(this.data.value) ? this.data.value : end;
      const value = raw > end ? end : raw;
      this.applyDate(value, false);
    },
    optionsFor(year, month) {
      const end = validDate(this.data.end) ? this.data.end : "2099-12-31";
      const [endYear, endMonth, endDay] = end.split("-").map(Number);
      const selectedYear = Number(year);
      const selectedMonth = Number(month);
      const startYear = Math.min(2020, selectedYear);
      const years = Array.from({ length: Math.max(1, endYear - startYear + 1) }, (_, index) => String(startYear + index));
      const maxMonth = selectedYear === endYear ? endMonth : 12;
      const months = Array.from({ length: maxMonth }, (_, index) => pad(index + 1));
      const maxDay = selectedYear === endYear && selectedMonth === endMonth ? endDay : daysInMonth(selectedYear, selectedMonth);
      const days = Array.from({ length: maxDay }, (_, index) => pad(index + 1));
      return { years, months, days };
    },
    applyDate(value, emit) {
      if (!validDate(value)) return;
      const end = validDate(this.data.end) ? this.data.end : "2099-12-31";
      const safe = value > end ? end : value;
      let [year, month, day] = safe.split("-");
      let options = this.optionsFor(year, month);
      if (!options.months.includes(month)) month = options.months[options.months.length - 1];
      options = this.optionsFor(year, month);
      if (!options.days.includes(day)) day = options.days[options.days.length - 1];
      const normalized = `${year}-${month}-${day}`;
      this.setData({
        ...options,
        selectedYear: year,
        selectedMonth: month,
        selectedDay: day,
        yearIndex: Math.max(0, options.years.indexOf(year)),
        monthIndex: Math.max(0, options.months.indexOf(month)),
        dayIndex: Math.max(0, options.days.indexOf(day))
      });
      if (emit) this.triggerEvent("change", { value: normalized });
    },
    chooseYear(event) {
      const year = this.data.years[Number(event.detail.value)];
      if (year) this.applyDate(`${year}-${this.data.selectedMonth}-${this.data.selectedDay}`, true);
    },
    chooseMonth(event) {
      const month = this.data.months[Number(event.detail.value)];
      if (month) this.applyDate(`${this.data.selectedYear}-${month}-${this.data.selectedDay}`, true);
    },
    chooseDay(event) {
      const day = this.data.days[Number(event.detail.value)];
      if (day) this.applyDate(`${this.data.selectedYear}-${this.data.selectedMonth}-${day}`, true);
    }
  }
});

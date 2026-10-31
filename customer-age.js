(() => {
  "use strict";

  // Display-only full years. Birth dates remain calendar dates, not instants.
  function calendarDate(value) {
    const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] ? { year, month, day } : null;
  }

  function format(value, now = new Date()) {
    const birth = calendarDate(value);
    if (!birth || !Number.isFinite(now.valueOf())) return "—";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now);
    const today = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    const years = today.year - birth.year - (today.month < birth.month || (today.month === birth.month && today.day < birth.day) ? 1 : 0);
    return years >= 0 ? `${years} 岁` : "—";
  }

  window.CustomerAge = Object.freeze({ format });
})();

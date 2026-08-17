(() => {
  "use strict";

  const pad2 = (value) => String(value).padStart(2, "0");
  const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

  function fromParts(parts) {
    const [, year, month, day, hour, minute, second = "0"] = parts;
    const numericYear = Number(year);
    const values = [month, day, hour, minute, second].map(Number);
    const leapYear = numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
      !Number.isInteger(numericYear) ||
      values.some((value) => !Number.isInteger(value)) ||
      values[0] < 1 || values[0] > 12 ||
      values[1] < 1 || values[1] > daysInMonth[values[0] - 1] ||
      values[2] < 0 || values[2] > 23 ||
      values[3] < 0 || values[3] > 59 ||
      values[4] < 0 || values[4] > 59
    ) return "";
    return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  }

  function fromInstant(date) {
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return "";
    const chinaTime = new Date(date.valueOf() + CHINA_OFFSET_MS);
    return `${chinaTime.getUTCFullYear()}-${pad2(chinaTime.getUTCMonth() + 1)}-${pad2(chinaTime.getUTCDate())} ${pad2(chinaTime.getUTCHours())}:${pad2(chinaTime.getUTCMinutes())}:${pad2(chinaTime.getUTCSeconds())}`;
  }

  function format(value, fallback = "—") {
    if (value === null || value === undefined || value === "") return fallback;
    if (value instanceof Date) return fromInstant(value) || fallback;
    if (typeof value === "number") return fromInstant(new Date(value)) || fallback;

    const text = String(value).trim();
    if (!text) return fallback;
    if (/^\d{4}-\d{1,2}-\d{1,2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      return fromInstant(new Date(text)) || fallback;
    }
    // CloudBase PG can return `... .65923 +0800 CST`. Parsing that with
    // Date is browser-dependent, so retain its UTC+8 wall time and discard
    // only sub-second precision and the trailing zone label.
    const parts = text.match(/^(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})(?:日)?[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    return parts ? (fromParts(parts) || fallback) : fallback;
  }

  window.AppDateTime = Object.freeze({ format });
})();

const TIME_OPTIONS = Object.freeze([
  { value: "ALL", label: "全部时间" },
  { value: "LAST_7", label: "近 7 天" },
  { value: "LAST_MONTH", label: "近 1 个月" },
  { value: "QUARTER", label: "本季度" },
  { value: "YEAR", label: "本年度" },
  { value: "CUSTOM", label: "自定义日期" }
]);

const STATUS_OPTIONS = Object.freeze([
  { value: "ALL", label: "全部状态" },
  { value: "PENDING", label: "待审核" },
  { value: "APPROVED", label: "审核通过" },
  { value: "REJECTED", label: "已驳回" },
  { value: "CLOSED", label: "已关闭" }
]);

const VERIFICATION_TYPES = Object.freeze([
  { value: "ALL", label: "全部类型" },
  { value: "NORMAL", label: "正常核销" },
  { value: "EXPERIENCE", label: "体验核销" },
  { value: "SUPPLEMENT", label: "历史补录" }
]);

const RECHARGE_TYPES = Object.freeze([
  { value: "ALL", label: "全部类型" },
  { value: "NEW", label: "充值申请" },
  { value: "REFUND", label: "退费申请" },
  { value: "VOID", label: "历史作废" }
]);

const CUSTOMER_PROCESS_OPTIONS = Object.freeze([
  { value: "ALL", label: "全部客户" },
  { value: "INFORMATION_ONLY", label: "有信息但没有充值" },
  { value: "RECHARGED_NO_CONSUMPTION", label: "已充值但没有消费" },
  { value: "RECHARGED_WITH_CONSUMPTION", label: "已充值并已有消费" }
]);

const CUSTOMER_STATUS_OPTIONS = Object.freeze([
  { value: "ALL", label: "全部状态" },
  { value: "ACTIVE", label: "活跃" },
  { value: "ARCHIVED", label: "已存档" }
]);

function two(value) { return String(value).padStart(2, "0"); }
function dateText(date) { return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`; }
function businessToday() { return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function dateFrom(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
}
function addDays(value, amount) {
  const date = dateFrom(value);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + amount);
  return dateText(date);
}

function timeRange(value, custom = {}) {
  const type = String(value || "ALL").toUpperCase();
  const today = businessToday();
  const current = dateFrom(today);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  if (type === "ALL") return { startDate: "", endDate: "" };
  if (type === "CUSTOM") return { startDate: custom.startDate || "", endDate: custom.endDate || "" };
  if (type === "LAST_7") return { startDate: addDays(today, -6), endDate: today };
  if (type === "LAST_MONTH") {
    const start = new Date(Date.UTC(year, month, current.getUTCDate()));
    start.setUTCMonth(start.getUTCMonth() - 1);
    return { startDate: dateText(start), endDate: today };
  }
  if (type === "QUARTER") return { startDate: dateText(new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1))), endDate: today };
  if (type === "YEAR") return { startDate: `${year}-01-01`, endDate: today };
  return { startDate: "", endDate: "" };
}

function displayDate(value) {
  const source = unwrapDateTime(value);
  const direct = String(source || "").trim().match(/^(\d{4}-\d{2}-\d{2})$/);
  if (direct) return direct[1];
  const millis = dateTimeMillis(source);
  if (!Number.isFinite(millis)) return "—";
  return new Date(millis + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function wrappedNumber(value) {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === "number") return Number.isFinite(current) ? current : NaN;
    if (typeof current === "string" && /^-?\d+(?:\.\d+)?$/.test(current.trim())) return Number(current);
    if (!current || typeof current !== "object") return NaN;
    const key = ["$numberLong", "$numberInt", "$numberDouble", "numberLong", "long", "value"]
      .find((item) => current[item] !== undefined && current[item] !== current);
    if (!key) return NaN;
    current = current[key];
  }
  return NaN;
}

function unwrapDateTime(value) {
  let current = value;
  const keys = ["$date", "date", "value", "timestamp", "time", "iso", "isoString", "datetime", "dateTime"];
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (Object.prototype.toString.call(current) === "[object Date]") return current.valueOf();
    const directNumber = wrappedNumber(current);
    if (Number.isFinite(directNumber)) return directNumber;
    const seconds = wrappedNumber(current.seconds ?? current._seconds);
    const nanoseconds = wrappedNumber(current.nanoseconds ?? current._nanoseconds ?? 0);
    if (Number.isFinite(seconds)) return seconds * 1000 + (Number.isFinite(nanoseconds) ? nanoseconds : 0) / 1000000;
    const milliseconds = wrappedNumber(current.milliseconds ?? current._milliseconds);
    if (Number.isFinite(milliseconds)) return milliseconds;
    const key = keys.find((item) => current[item] !== undefined && current[item] !== current);
    if (!key) break;
    current = current[key];
  }
  return current;
}

function dateTimeMillis(value) {
  const source = unwrapDateTime(value);
  if (source === undefined || source === null || source === "") return NaN;
  if (Object.prototype.toString.call(source) === "[object Date]") return source.valueOf();
  if (typeof source === "number" || /^\d{10,16}$/.test(String(source).trim())) {
    let amount = Number(source);
    if (!Number.isFinite(amount)) return NaN;
    if (Math.abs(amount) < 100000000000) amount *= 1000;
    if (Math.abs(amount) > 100000000000000) amount /= 1000;
    return amount;
  }
  let text = String(source).trim();
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith('"') && text.endsWith('"'))) {
    try {
      const decoded = JSON.parse(text);
      if (decoded !== source) return dateTimeMillis(decoded);
    } catch (_) {}
  }
  const postgres = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s*)(Z|[+-]\d{2}(?::?\d{2})?)?$/i);
  if (postgres) {
    const time = postgres[2].replace(/\.(\d{3})\d+$/, ".$1");
    let zone = postgres[3] || "Z";
    if (/^[+-]\d{2}$/.test(zone)) zone += ":00";
    else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    text = `${postgres[1]}T${time}${zone}`;
  }
  const parsed = new Date(text);
  return parsed.valueOf();
}

function displayDateTime(value) {
  const millis = dateTimeMillis(value);
  if (!Number.isFinite(millis)) return "—";
  return new Date(millis + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function displayDateTimeAny(...values) {
  for (const value of values) {
    const output = displayDateTime(value);
    if (output !== "—") return output;
  }
  return "—";
}

function displayDateAny(...values) {
  for (const value of values) {
    const output = displayDate(value);
    if (output !== "—") return output;
  }
  return "—";
}

function statusLabel(value) {
  return ({ PENDING: "待审核", APPROVED: "审核通过", REJECTED: "已驳回", VOIDED: "已关闭", CLOSED: "已关闭" })[String(value || "").toUpperCase()] || "未记录";
}

function typeLabel(recordType, value) {
  const code = String(value || "").toUpperCase();
  if (recordType === "VERIFICATION") return ({ NORMAL: "正常核销", EXPERIENCE: "体验核销", SUPPLEMENT: "历史补录" })[code] || "核销";
  return ({ NEW: "充值申请", REFUND: "退费申请", VOID: "历史作废" })[code] || "充值";
}

function normalizeRecord(item = {}, recordType = "RECHARGE") {
  const type = String(recordType || "RECHARGE").toUpperCase();
  const originalType = String(item.originalType || item.original_type || "").toUpperCase();
  const recordStatus = String(item.recordStatus || item.record_status || item.application_status || "").toUpperCase();
  const completedWithoutReview = type === "VERIFICATION"
    && ["NORMAL", "EXPERIENCE"].includes(originalType)
    && recordStatus === "APPROVED";
  return {
    id: String(item.id || ""),
    recordCode: String(item.recordCode || item.record_code || "—"),
    originalType,
    typeLabel: typeLabel(type, originalType),
    unitCount: Number(item.unitCount !== undefined ? item.unitCount : item.unit_count || 0),
    recordStatus,
    statusLabel: completedWithoutReview ? "已完成" : statusLabel(recordStatus),
    submittedAt: displayDateTimeAny(
      item.submittedAt, item.submitted_at, item.originalSubmittedAt, item.original_submitted_at,
      item.applicationTime, item.application_time, item.createdAt, item.created_at
    ),
    customerCode: String(item.customerCode || item.customer_code || ""),
    customerName: String(item.customerName || item.customer_name || "—"),
    birthDate: displayDateAny(item.birthDate, item.birth_date),
    storeId: String(item.storeId || item.store_id || ""),
    storeName: String(item.storeName || item.store_name || "—"),
    storeCode: String(item.storeCode || item.store_code || ""),
    productId: String(item.productId || item.product_id || ""),
    productName: String(item.productName || item.product_name || "—"),
    productCode: String(item.productCode || item.product_code || ""),
    teacherName: String(item.teacherName || item.teacher_name || ""),
    teacherCode: String(item.teacherCode || item.teacher_code || "")
  };
}

function optionIndex(options, value) {
  const index = options.findIndex((item) => item.value === value);
  return index >= 0 ? index : 0;
}

module.exports = {
  TIME_OPTIONS, STATUS_OPTIONS, VERIFICATION_TYPES, RECHARGE_TYPES,
  CUSTOMER_PROCESS_OPTIONS, CUSTOMER_STATUS_OPTIONS,
  businessToday, timeRange, displayDate, displayDateAny, displayDateTime, displayDateTimeAny, statusLabel, typeLabel,
  normalizeRecord, optionIndex
};

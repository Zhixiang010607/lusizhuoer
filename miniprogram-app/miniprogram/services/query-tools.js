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
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "—";
}

function displayDateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "—";
  return new Date(parsed.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function statusLabel(value) {
  return ({ PENDING: "待审核", APPROVED: "审核通过", REJECTED: "已驳回", VOIDED: "已关闭" })[String(value || "").toUpperCase()] || "未记录";
}

function typeLabel(recordType, value) {
  const code = String(value || "").toUpperCase();
  if (recordType === "VERIFICATION") return ({ NORMAL: "正常核销", EXPERIENCE: "体验核销", SUPPLEMENT: "历史补录" })[code] || "核销";
  return ({ NEW: "充值申请", REFUND: "退费申请", VOID: "历史作废" })[code] || "充值";
}

function normalizeRecord(item = {}, recordType = "RECHARGE") {
  const type = String(recordType || "RECHARGE").toUpperCase();
  return {
    id: String(item.id || ""),
    recordCode: String(item.recordCode || item.record_code || "—"),
    originalType: String(item.originalType || item.original_type || ""),
    typeLabel: typeLabel(type, item.originalType || item.original_type),
    unitCount: Number(item.unitCount !== undefined ? item.unitCount : item.unit_count || 0),
    recordStatus: String(item.recordStatus || item.record_status || item.application_status || ""),
    statusLabel: statusLabel(item.recordStatus || item.record_status || item.application_status),
    submittedAt: displayDateTime(item.submittedAt || item.submitted_at || item.original_submitted_at || item.application_time),
    customerCode: String(item.customerCode || item.customer_code || ""),
    customerName: String(item.customerName || item.customer_name || "—"),
    birthDate: displayDate(item.birthDate || item.birth_date),
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
  businessToday, timeRange, displayDate, displayDateTime, statusLabel, typeLabel,
  normalizeRecord, optionIndex
};

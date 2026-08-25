const RANGE_OPTIONS = Object.freeze([
  { value: "TODAY", label: "今天" },
  { value: "WEEK", label: "本周" },
  { value: "MONTH", label: "本月" },
  { value: "QUARTER", label: "本季度" },
  { value: "YEAR", label: "本年" },
  { value: "ALL", label: "全部" },
  { value: "CUSTOM", label: "自定义" }
]);

const HQ_PERIOD_OPTIONS = Object.freeze([
  { value: "THIS_WEEK", label: "本周（周一至今天）" },
  { value: "THIS_MONTH", label: "本月（1 日至今天）" },
  { value: "LAST_7", label: "近 7 日" },
  { value: "LAST_30", label: "近 30 日" },
  { value: "Q1", label: "本年第一季度（1—3 月）" },
  { value: "Q2", label: "本年第二季度（4—6 月）" },
  { value: "Q3", label: "本年第三季度（7—9 月）" },
  { value: "Q4", label: "本年第四季度（10—12 月）" },
  { value: "YTD", label: "本年截至今天" },
  { value: "CUSTOM", label: "自定义" }
]);

const TYPE_CONFIG = Object.freeze({
  VERIFICATION: { label: "核销", recordType: "VERIFICATION", verificationType: "NORMAL" },
  RECHARGE: { label: "充值", recordType: "RECHARGE", rechargeType: "NEW" },
  EXPERIENCE: { label: "体验", recordType: "VERIFICATION", verificationType: "EXPERIENCE" },
  REFUND: { label: "退费", recordType: "RECHARGE", rechargeType: "REFUND" }
});

const METRIC_KEYS = Object.freeze(["verification", "recharge", "experience", "refund"]);
const EMPTY_TOTALS = Object.freeze({ verification: 0, recharge: 0, experience: 0, refund: 0 });

function count(value) { return Number(value || 0); }
function two(value) { return String(value).padStart(2, "0"); }
function dateText(date) { return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`; }
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
function today() { return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function rangeDays(startDate, endDate) {
  const start = dateFrom(startDate);
  const end = dateFrom(endDate);
  return start && end ? Math.floor((end - start) / 86400000) + 1 : 0;
}

function scopedRange(preset, custom = {}) {
  const currentText = today();
  const current = dateFrom(currentText);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  if (preset === "ALL") return { startDate: "", endDate: "" };
  if (preset === "CUSTOM") return { startDate: custom.startDate || "", endDate: custom.endDate || "" };
  if (preset === "TODAY") return { startDate: currentText, endDate: currentText };
  if (preset === "WEEK") return { startDate: addDays(currentText, 1 - (current.getUTCDay() || 7)), endDate: currentText };
  if (preset === "QUARTER") return { startDate: dateText(new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1))), endDate: currentText };
  if (preset === "YEAR") return { startDate: `${year}-01-01`, endDate: currentText };
  return { startDate: dateText(new Date(Date.UTC(year, month, 1))), endDate: currentText };
}

function hqRange(period, custom = {}) {
  const currentText = today();
  const current = dateFrom(currentText);
  const year = current.getUTCFullYear();
  if (period === "CUSTOM") return { startDate: custom.startDate || "", endDate: custom.endDate || "" };
  if (period === "THIS_WEEK") return scopedRange("WEEK");
  if (period === "THIS_MONTH") return scopedRange("MONTH");
  if (period === "LAST_7") return { startDate: addDays(currentText, -6), endDate: currentText };
  if (period === "YTD") return { startDate: `${year}-01-01`, endDate: currentText };
  if (/^Q[1-4]$/.test(period)) {
    const startMonth = (Number(period.slice(1)) - 1) * 3;
    const startDate = dateText(new Date(Date.UTC(year, startMonth, 1)));
    const quarterEnd = dateText(new Date(Date.UTC(year, startMonth + 3, 0)));
    const endDate = startDate > currentText ? quarterEnd : (quarterEnd < currentText ? quarterEnd : currentText);
    return { startDate, endDate };
  }
  return { startDate: addDays(currentText, -29), endDate: currentText };
}

function payload(startDate, endDate) { return startDate && endDate ? { startDate, endDate } : {}; }
function displayDate(value) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "—";
}
function displayDateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "—";
  return new Date(parsed.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function totals(source = {}) {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, count(source[key])]));
}
function tabs(source = {}, activeType = "VERIFICATION") {
  return Object.entries(TYPE_CONFIG).map(([type, config]) => ({
    type, label: config.label, total: count(source[type.toLowerCase()]), active: type === activeType
  }));
}
function products(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    productId: String(item.productId || item.product_id || ""),
    productCode: String(item.productCode || item.product_code || ""),
    productName: String(item.productName || item.product_name || "未命名项目"),
    verification: count(item.verification), recharge: count(item.recharge),
    experience: count(item.experience), refund: count(item.refund)
  }));
}
function records(items = [], type = "VERIFICATION") {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item.id || ""), type, category: type, recordCode: String(item.recordCode || "—"),
    storeName: String(item.storeName || "—"), storeCode: String(item.storeCode || ""),
    customerName: String(item.customerName || "—"), customerCode: String(item.customerCode || ""),
    productName: String(item.productName || "—"), unitCount: count(item.unitCount),
    submittedAt: displayDateTime(item.submittedAt)
  }));
}
function storeFacts(store = {}) {
  const region = [store.province, store.city, store.district].filter(Boolean).join(" · ") || "未填写";
  const status = String(store.store_status || store.status || "").toUpperCase() === "ARCHIVED" ? "封存" : "活跃";
  return [
    { label: "唯一身份 ID", value: String(store.auth_uid || "未绑定登录账号") },
    { label: "业务编号", value: String(store.store_code || store.storeCode || "—") },
    { label: "门店名称", value: String(store.store_name || store.storeName || "—") },
    { label: "地区", value: region },
    { label: "详细地址", value: String(store.address_detail || "未填写") },
    { label: "门店状态", value: status },
    { label: "联系人", value: String(store.contact_name || "未填写") },
    { label: "联系电话", value: String(store.contact_phone || store.phone || "未填写") }
  ];
}
function teacherFacts(profile = {}, session = {}) {
  return [
    { label: "老师姓名", value: String(profile.teacherName || session.staffName || "—") },
    { label: "老师短编号", value: String(profile.teacherCode || session.staffCode || "—") },
    { label: "登录身份", value: "老师本人" }
  ];
}
function hqRows(items = [], dimension = "store") {
  const label = { store: "门店", teacher: "老师", project: "项目" }[dimension] || "对象";
  const rows = (Array.isArray(items) ? items : []).map((row, index) => {
    const name = String(row.entityName || row.name || row.entity_name || "未指定对象");
    const code = String(row.entityCode || row.code || row.entity_code || "");
    const recharge = count(row.recharge !== undefined ? row.recharge : row.recharge_count);
    const verification = count(row.verification !== undefined ? row.verification : row.verification_count);
    const experience = count(row.experience !== undefined ? row.experience : row.experience_count);
    const refund = count(row.refund !== undefined ? row.refund : row.refund_count);
    return {
      rank: index + 1, entityId: String(row.entityId || row.entity_id || ""),
      name: code && !name.includes(code) ? `${name} · ${code}` : name,
      dimensionLabel: label, recharge, verification, experience, refund,
      businessTotal: recharge + verification + experience + refund
    };
  });
  const maximum = Math.max(1, ...rows.map((row) => row.businessTotal));
  const barMetrics = ["recharge", "verification", "experience", "refund"];
  const metricMaximum = Math.max(1, ...rows.flatMap((row) => barMetrics.map((metric) => row[metric])));
  return rows.map((row) => ({
    ...row,
    barWidth: `${Math.max(4, row.businessTotal / maximum * 100).toFixed(1)}%`,
    bars: barMetrics.map((metric) => ({
      metric, value: row[metric], height: `${Math.max(row[metric] ? 3 : 0, row[metric] / metricMaximum * 100).toFixed(1)}%`
    }))
  }));
}

function flexibleAxis(maxValue, targetIntervals = 5) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { max: 5, step: 1, ticks: [0, 1, 2, 3, 4, 5] };
  const roughStep = maxValue / targetIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = factor * magnitude;
  const max = Math.ceil(maxValue / step) * step;
  return { max, step, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step) };
}

function signedAxis(values = []) {
  const minimum = Math.min(0, ...values.map(count));
  const maximum = Math.max(0, ...values.map(count));
  if (minimum >= 0) {
    const positive = flexibleAxis(maximum);
    return { min: 0, max: positive.max, step: positive.step, ticks: positive.ticks };
  }
  const positive = flexibleAxis(Math.max(Math.abs(minimum), maximum), 4);
  const ticks = [];
  for (let tick = -positive.max; tick <= positive.max; tick += positive.step) ticks.push(tick);
  return { min: -positive.max, max: positive.max, step: positive.step, ticks };
}

function hqChart(items = [], dimension = "store") {
  const rows = hqRows(items, dimension);
  const metrics = ["recharge", "verification", "experience", "refund"];
  const axis = signedAxis(rows.flatMap((row) => metrics.map((metric) => row[metric])));
  const range = Math.max(1, axis.max - axis.min);
  const positions = [5, 29, 53, 77];
  return {
    rows: rows.map((row) => ({
      ...row,
      bars: metrics.map((metric, index) => {
        const value = row[metric];
        const top = (axis.max - Math.max(value, 0)) / range * 100;
        const height = Math.abs(value) / range * 100;
        const valueTop = value < 0 ? top + height : top;
        return {
          metric, value, left: `${positions[index]}%`, top: `${top.toFixed(2)}%`,
          height: `${height.toFixed(2)}%`, valueTop: `${valueTop.toFixed(2)}%`,
          valueClass: value < 0 ? "negative" : value === 0 ? "zero" : "positive"
        };
      })
    })),
    axis: {
      ...axis,
      ticks: [...axis.ticks].reverse().map((value) => ({
        value, label: String(value), top: `${((axis.max - value) / range * 100).toFixed(2)}%`,
        zero: value === 0
      }))
    }
  };
}
function customers(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    customerId: String(item.customerId || item.customer_id || ""),
    customerCode: String(item.customerCode || item.customer_code || ""),
    customerName: String(item.customerName || item.customer_name || "未命名客户"),
    storeName: String(item.storeName || item.store_name || "—"),
    birthDate: displayDate(item.birthDate || item.birth_date),
    rechargeCount: count(item.rechargeCount !== undefined ? item.rechargeCount : item.total_recharge_count),
    verificationCount: count(item.verificationCount !== undefined ? item.verificationCount : item.total_verification_count)
  }));
}
function customerGroup(group = {}) {
  const total = count(group.total);
  const pageSize = Math.max(1, count(group.pageSize || group.page_size) || 10);
  const page = Math.max(1, count(group.page) || 1);
  return { rows: customers(group.records), total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
function storeCustomerGroups(store = {}) {
  const withStore = (items) => (Array.isArray(items) ? items : []).map((item) => ({
    ...item, store_name: item.store_name || store.store_name || store.storeName || "—"
  }));
  return {
    active: customerGroup({ records: withStore(store.customers), total: store.customer_total, page: store.customer_page, pageSize: store.customer_page_size }),
    archived: customerGroup({ records: withStore(store.archived_customers), total: store.archived_customer_total, page: store.archived_customer_page, pageSize: store.archived_customer_page_size })
  };
}
function periodLabel(preset, startDate, endDate) {
  if (preset === "ALL") return "全部时间";
  const label = RANGE_OPTIONS.find((item) => item.value === preset)?.label || "自定义";
  return `${label} · ${startDate === endDate ? startDate : `${startDate} 至 ${endDate}`}`;
}
function pageState(page = {}) {
  const total = count(page.total);
  const pageSize = Math.max(1, count(page.pageSize) || 10);
  const number = Math.max(1, count(page.page) || 1);
  return { total, page: number, pageSize, totalPages: Math.max(1, count(page.totalPages) || Math.ceil(total / pageSize)) };
}

module.exports = {
  RANGE_OPTIONS, HQ_PERIOD_OPTIONS, TYPE_CONFIG, METRIC_KEYS, EMPTY_TOTALS,
  count, today, rangeDays, scopedRange, hqRange, payload, totals, tabs, products,
  records, storeFacts, teacherFacts, hqRows, hqChart, flexibleAxis, signedAxis,
  customerGroup, storeCustomerGroups, periodLabel, pageState
};

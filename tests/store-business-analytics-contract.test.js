"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const html = read("store-detail.html");
const analysisHtml = read("store-analysis.html");
const detail = read("store-detail.js");
const analysis = read("store-analysis.js");
const analyticsData = read("store-analytics-data.js");
const exporter = read("store-dashboard-export.js");
const orderExporter = read("order-export.js");
const storeManagementHtml = read("store-management.html");
const storeManagement = read("store-management.js");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const auth = read("auth-ui.js");
const css = read("styles.css");
const activeCustomerSection = html.slice(html.indexOf('id="storeActiveCustomers"'), html.indexOf('</section>', html.indexOf('id="storeActiveCustomers"')));
const archivedCustomerSection = html.slice(html.indexOf('id="storeArchivedCustomers"'), html.indexOf('</section>', html.indexOf('id="storeArchivedCustomers"')));

const includes = (source, expected, label) => assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);

includes(html, 'data-store-range-preset="MONTH"', "overview exposes the monthly preset");
assert.match(html, /class="active" type="button" data-store-range-preset="MONTH"/, "overview defaults to this month");
for (const preset of ["TODAY", "WEEK", "MONTH", "QUARTER", "YEAR", "ALL", "CUSTOM"]) {
  includes(html, `data-store-range-preset="${preset}"`, `${preset} range preset`);
}
includes(html, '<th scope="col">产品</th><th scope="col">核销</th><th scope="col">充值</th><th scope="col">体验</th><th scope="col">退费</th>', "store overview uses the same matrix orientation as the teacher overview");
includes(html, 'id="storeAnalyticsBody"', "overview has project summary rows");
assert.ok(html.indexOf('id="storeBasic"') < html.indexOf('id="storeBusinessOverview"'), "store basic profile appears before business analytics");
assert.doesNotMatch(html, /id="storeAnalyticsLinks"|class="store-analytics-links"/, "overview removes the four duplicate metric shortcut buttons");
assert.doesNotMatch(html, /id="storeTeachers"|id="storeTeacherBody"|老师统计|各老师核销数据/, "store detail removes the teacher summary section");
assert.doesNotMatch(html, /id="storeProjects"|id="storeProjectBody"|体验项目剩余次数/, "store homepage has no legacy project panel or teacher quota panel");
assert.ok(html.indexOf('id="storeBusinessOverview"') < html.indexOf('id="storeBusinessDetails"'), "summary precedes business details");
assert.ok(html.indexOf('id="storeBusinessDetails"') < html.indexOf('id="storeActiveCustomers"'), "business details immediately precede customer lists");
assert.ok(html.indexOf('id="storeActiveCustomers"') < html.indexOf('id="storeArchivedCustomers"'), "active users precede archived users");
for (const [section, status] of [[activeCustomerSection, "active"], [archivedCustomerSection, "archived"]]) {
  assert.doesNotMatch(section, /<th>最近业务<\/th>|<th>状态<\/th>/, `${status} customer table removes time and status columns`);
  includes(section, '<th>姓名</th><th>门店</th><th>生日</th><th>充值次数</th><th>核销次数</th>', `${status} customer table uses the shared five columns`);
}
includes(activeCustomerSection, 'id="storeActiveCustomerBody"', "active bound customers have a dedicated table");
includes(archivedCustomerSection, 'id="storeArchivedCustomerBody"', "archived bound customers have a dedicated table");
includes(activeCustomerSection, '<h2 id="storeActiveCustomersTitle">活跃用户</h2>', "active customer heading matches teacher terminology");
includes(archivedCustomerSection, '<h2 id="storeArchivedCustomersTitle">封存用户</h2>', "archived customer heading matches teacher terminology");
includes(html, 'store-detail.js?v=0.16.6', "store detail script cache bust");
includes(html, 'store-analytics-data.js?v=0.2.0', "store analytics helper cache bust");
includes(html, 'styles.css?v=0.15.57', "store detail stylesheet cache bust");
for (const [type, label] of [["VERIFICATION", "核销"], ["RECHARGE", "充值"], ["EXPERIENCE", "体验"], ["REFUND", "退费"]]) {
  assert.match(html, new RegExp(`data-store-record-type="${type}"[\\s\\S]{0,120}<span>${label}</span>`), `${label} must be a dedicated store detail button`);
}
includes(html, 'id="storeBusinessDetails"', "store homepage includes the teacher-style business detail panel");
includes(html, 'id="storeBusinessPagination"', "store business details own numbered pagination");
includes(detail, 'analyticsPreset: "MONTH"', "store summary defaults to this month");
includes(detail, 'if (state.analyticsPreset === "ALL") return {}', "all-time selection omits date bounds");
includes(detail, 'class="teacher-summary-total"', "store summary renders the same total row as teacher summary");
includes(detail, 'metricCell(product.verification)}${metricCell(product.recharge)}${metricCell(product.experience)}${metricCell(product.refund)}', "each project uses teacher metric order");
assert.doesNotMatch(detail, /storeAnalyticsLinks|renderTeachers|teacherRows|teacherPage/, "removed shortcut and teacher UI has no renderer state");
includes(detail, 'toUpperCase() === "ACTIVE"', "active customer rows are restricted to active customers");
includes(detail, 'toUpperCase() === "ARCHIVED"', "archived customer rows are restricted to archived customers");
const customerRenderer = detail.slice(detail.indexOf("function renderCustomers"), detail.indexOf("function renderEmptyRows"));
assert.doesNotMatch(customerRenderer, /last_business_at|last_recharge_at|formatDateTime/, "customer list is independent of business timestamps");
includes(detail, 'colspan="5" class="query-empty"', "customer loading and empty states match the five visible columns");
includes(detail, 'action, ...data', "store detail uses the shared cloud function caller");
includes(detail, 'statusCategory: "APPROVED"', "store business details contain effective records only");
includes(detail, 'rechargeType: "NEW"', "recharge detail excludes refunds");
includes(detail, 'rechargeType: "REFUND"', "refund detail excludes new recharges");
includes(detail, 'verificationType: "NORMAL"', "normal verification detail excludes experience");
includes(detail, 'verificationType: "EXPERIENCE"', "experience detail is isolated");
includes(detail, 'customer-detail.html?${customerParams.toString()}', "store business customer names link to customer profiles");
includes(detail, 'data-store-business-page', "store business records include previous and next page controls");
includes(detail, 'data-store-business-jump', "store business records preserve direct page jump");
assert.doesNotMatch(detail, /storeBusinessLoadMore|继续加载|businessCursors|businessHasMore/, "store details do not use endless cursor loading");
assert.doesNotMatch(detail, /renderProjects|renderProjectRefundBreakdown|storeProjectBody/, "store detail removes the legacy lifetime-project renderer");
includes(analyticsData, 'if (period === "WEEK")', "store supports the same weekly range as teacher");
includes(analyticsData, 'if (period === "QUARTER")', "store supports the same quarterly range as teacher");
includes(analyticsData, 'if (period === "YEAR")', "store supports the same yearly range as teacher");
includes(analyticsData, 'if (period === "ALL")', "store supports all-time range");
includes(analyticsData, 'allTime: !startDate && !endDate', "all-time request is explicit rather than accidentally defaulting to today");

const dashboardSource = cloud.slice(cloud.indexOf("async function getStoreDashboard"), cloud.indexOf("const STORE_ANALYTICS_METRICS"));
const dashboardProjectSource = dashboardSource.slice(
  dashboardSource.indexOf("WITH store_business_events AS"),
  dashboardSource.indexOf("SELECT COUNT(*) AS customer_total")
);
assert.match(dashboardProjectSource, /FROM public\.recharge_records r[\s\S]*?WHERE r\.store_id = \$\{storeId\}::bigint[\s\S]*?r\.record_status = 'APPROVED'/, "lifetime recharge totals are scoped to the selected store and approved records");
assert.match(dashboardProjectSource, /FROM public\.verification_records v[\s\S]*?WHERE v\.store_id = \$\{storeId\}::bigint[\s\S]*?v\.record_status = 'APPROVED'/, "lifetime verification totals are scoped to the selected store and approved records");
assert.doesNotMatch(dashboardProjectSource, /customer_product_balances|JOIN public\.customers|submitted_at\s*[<>=]/, "lifetime project totals do not depend on customer ownership, customer status, balances, or a date range");
includes(dashboardProjectSource, "CASE WHEN r.recharge_type = 'NEW' THEN r.unit_count ELSE 0 END", "gross recharge column counts NEW orders only");
includes(dashboardProjectSource, "CASE WHEN r.recharge_type = 'REFUND' THEN r.unit_count ELSE 0 END", "refund column counts REFUND orders only");
includes(dashboardProjectSource, "CASE WHEN r.recharge_type = 'VOID' THEN r.unit_count ELSE 0 END", "legacy void affects only the remaining calculation");
includes(dashboardProjectSource, "v.verification_type = 'NORMAL'", "only normal verification contributes to paid verification totals");
assert.doesNotMatch(dashboardProjectSource, /SUPPLEMENT/, "supplemental verification is absent from the current store totals");
includes(dashboardProjectSource, "v.verification_type = 'EXPERIENCE'", "experience is reported separately");
assert.match(dashboardProjectSource, /GROUP BY event\.customer_id, event\.product_id[\s\S]*?GREATEST|GREATEST\([\s\S]*?GROUP BY event\.customer_id, event\.product_id/, "remaining units are floored at customer-product level before project aggregation");
for (const field of [
  "refund_before_consumption_count",
  "refund_after_consumption_count",
  "refund_before_consumption_customer_count",
  "refund_after_consumption_customer_count",
  "refund_from_remaining_count",
  "refund_after_consumption_balance_count",
  "refund_breakdown_unknown_count",
  "total_legacy_void_count",
  "raw_remaining_count",
  "balance_floor_adjustment"
]) includes(dashboardProjectSource, `AS ${field}`, `project dashboard returns ${field}`);
assert.match(dashboardProjectSource, /first_paid_verification[\s\S]*?event\.verification_count > 0/, "refund timing is compared only with paid normal verification events");
assert.match(dashboardProjectSource, /refund_before_consumption_count[\s\S]*?refund_after_consumption_count/, "refund timing breakdown retains both pre-consumption and post-consumption categories");

// The stress dataset intentionally contains 90 customers with 5 available
// units and 10 customers that have already consumed 45 units before a refund
// of 10. Balances floor at each customer/product ledger: the 50 excess refund
// units cannot reduce the other 90 customers' 450 available units.
const stressBalanceRows = Array.from({ length: 100 }, (_, index) => ({
  recharge: 50,
  paidVerification: 45,
  refund: index % 10 === 9 ? 10 : 0
}));
const stressProject = stressBalanceRows.reduce((totals, row) => {
  const beforeRefund = Math.max(row.recharge - row.paidVerification, 0);
  const raw = row.recharge - row.paidVerification - row.refund;
  totals.recharge += row.recharge;
  totals.paidVerification += row.paidVerification;
  totals.refund += row.refund;
  totals.rawRemaining += raw;
  totals.remaining += Math.max(raw, 0);
  totals.refundFromRemaining += Math.min(row.refund, beforeRefund);
  totals.refundOverRemaining += Math.max(row.refund - beforeRefund, 0);
  return totals;
}, { recharge: 0, paidVerification: 0, refund: 0, rawRemaining: 0, remaining: 0, refundFromRemaining: 0, refundOverRemaining: 0 });
assert.deepEqual(stressProject, {
  recharge: 5000,
  paidVerification: 4500,
  refund: 100,
  rawRemaining: 400,
  remaining: 450,
  refundFromRemaining: 50,
  refundOverRemaining: 50
}, "customer-level zero floors explain why 5000 - 4500 - 100 does not reduce the project balance below 450");
assert.match(dashboardProjectSource, /WHERE p\.product_status = 'ACTIVE'[\s\S]*?UNION[\s\S]*?SELECT event\.product_id/, "active zero products and historical store products remain visible");
assert.equal((dashboardSource.match(/(?:c\.)?created_store_id = \$\{storeId\}::bigint\s+AND (?:c\.)?customer_status = 'ACTIVE'/g) || []).length, 2, "customer count and page queries both return this store's active bound customers");
assert.equal((dashboardSource.match(/(?:c\.)?created_store_id = \$\{storeId\}::bigint\s+AND (?:c\.)?customer_status = 'ARCHIVED'/g) || []).length, 2, "customer count and page queries both return this store's archived bound customers");
includes(dashboardSource, "archived_customers: archivedCustomers", "store dashboard returns a separate archived customer page");
includes(dashboardSource, "teachers: []", "removed teacher table no longer requires a dashboard query");
assert.doesNotMatch(dashboardSource, /JOIN public\.teachers/, "store dashboard does not fetch teacher aggregates");

includes(analysisHtml, 'id="storeAnalysisChart"', "store chart");
includes(analysisHtml, 'id="teacherAnalysisChart"', "teacher chart");
includes(analysisHtml, 'id="productAnalysisChart"', "product chart");
includes(analysis, 'Number(b.value || 0) - Number(a.value || 0)', "charts sort descending");
includes(analysis, '["today", "last7", "month"].find', "metric page preserves matching time presets");
includes(css, ".store-chart-scroll", "chart scrolling class");
includes(css, "overflow-x: auto", "horizontal scrolling");
includes(analyticsData, 'action: "getStoreBusinessAnalytics"', "frontend database action");

includes(cloud, "r.record_status = 'APPROVED'", "approved recharge/refund only");
includes(cloud, "v.record_status = 'APPROVED'", "approved verification/experience only");
includes(cloud, "r.recharge_type IN ('NEW', 'REFUND')", "recharge and refund metric split");
includes(cloud, "v.verification_type IN ('NORMAL', 'EXPERIENCE')", "normal and experience split");
includes(cloud, "WHERE p.product_status = 'ACTIVE'", "active products included with zero");
includes(cloud, "SELECT event.product_id", "historical products with period events included");
includes(cloud, "WHERE t.teacher_status = 'ACTIVE'", "active teachers included with zero");
includes(cloud, "AND account.account_status = 'ACTIVE'", "active teacher accounts required for zero inclusion");
includes(cloud, "SELECT event.teacher_id", "historical teachers with period events included");
const analyticsEventSource = cloud.slice(cloud.indexOf("function storeAnalyticsEventCte"), cloud.indexOf("function storeAnalyticsCounts"));
assert.doesNotMatch(analyticsEventSource.slice(analyticsEventSource.indexOf("business_events AS")), /product_status|teacher_status|store_status/, "period event membership is independent of entity status");

assert.doesNotMatch(html, /exportStoreAnalyticsPdf|store-dashboard-export\.js|order-export\.js/, "store overview does not offer or load PDF export");
includes(analysisHtml, 'id="exportAnalysisPdf"', "metric PDF export");
includes(exporter, "for (let index = 0; index < Math.max(products.length, 1); index += 4)", "summary table limits projects per page");
includes(exporter, "const pageSize = 24", "long tables paginate vertically");
includes(exporter, 'const includePhone = dimension !== "products"', "stores and teachers print phone but projects do not");
includes(exporter, 'Object.keys(dimensions).forEach', "each metric exports all classifications");
includes(exporter, "pages.push(...dimensionPages", "each classification starts a table page");
includes(exporter, "renderReportPages", "PDF table pages can be rendered for visual verification");
assert.doesNotMatch(exporter, /store-chart|bar-chart|drawBar/i, "PDF export uses tables, not charts");
includes(orderExporter, "exportCanvasPagesPdf", "PDF encoder accepts generated table pages");

includes(auth, '"store-analysis.html"', "store analysis route is authorized");
includes(analysisHtml, 'auth-ui.js?v=0.19.3', "analysis route loads current auth isolation");
includes(cloud, 'if (action === "getStoreBusinessAnalytics")', "cloud action dispatched");
includes(cloud, 'if (action === "queryStoreBusinessRecords")', "store detail query action dispatched");
includes(cloud, 'r.recharge_type = ${sqlText(rechargeType)}', "store detail backend separates recharge and refund record types");
const storeRecordQuery = cloud.slice(cloud.indexOf("async function queryStoreBusinessRecords"), cloud.indexOf("async function getStoreDashboard"));
assert.match(storeRecordQuery, /numberedPage[\s\S]*pageSize[\s\S]*OFFSET/, "store detail backend supports numbered server pagination");
assert.match(storeRecordQuery, /total:\s*filteredTotal[\s\S]*totalPages/, "store detail backend returns total rows and total pages");

includes(html, 'id="storeStatusAction"', "store homepage owns the status action");
includes(html, 'id="storeStatusMessage"', "store status operation has inline feedback");
includes(detail, 'state.sessionRole === "hq"', "store status action is visible and callable only for HQ");
includes(detail, 'setMasterStatus({ storeId, status: next })', "store homepage uses the master status endpoint");
includes(detail, 'String(result?.status || "").toUpperCase() !== next', "store homepage requires an acknowledged persisted status");
includes(detail, 'AUTH_ARCHIVE_FAILED', "store archive failure explains CloudBase credential permission failures");
includes(detail, 'result?.warning ? "warning" : "success"', "store archive keeps a successful database archive visible while surfacing credential warnings");
includes(css, '.status.store-status-archived', "archived store header gets a dedicated state");
assert.match(css, /\.store-status-badge\.archived\s*\{\s*color:\s*#a33131;\s*background:\s*#fdecec;/, "store archive badges use the customer archive palette");
assert.match(css, /\.teacher-status-badge\.archived,[\s\S]{0,80}\.store-status-badge\.archived\s*\{\s*color:\s*#a33131;\s*background:\s*#fdecec;/, "teacher and store directory archive badges share the customer archive palette");

includes(storeManagementHtml, 'store-management.js?v=0.14.26', "store directory script cache bust");
includes(storeManagementHtml, 'styles.css?v=0.15.49', "store directory stylesheet cache bust");
includes(storeManagement, 'href="store-detail.html?storeId=${encodeURIComponent(reference)}"', "store directory opens the selected store homepage");
includes(storeManagement, '>进入主页</a>', "store directory action only opens the selected store homepage");
assert.doesNotMatch(storeManagement, /data-store-status-ref|setMasterStatus|setStaffStatus|toggleStoreStatus/, "store directory cannot change store status directly");
assert.doesNotMatch(storeManagementHtml, /封存门店账号|激活门店账号/, "store directory contains no direct archive action");

console.log("store business analytics contract: ok");

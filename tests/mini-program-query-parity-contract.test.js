"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");
const tools = require(path.join(mini, "services", "query-tools.js"));

test("HQ and store mini-program navigation exposes role-appropriate database searches", () => {
  const homeJs = read("pages", "home", "index.js");
  const homeWxml = read("pages", "home", "index.wxml");
  for (const label of ["客户查询", "未核销客户", "低余次客户", "充值查询", "核销查询", "产品查询"]) assert.match(homeWxml, new RegExp(label));
  assert.match(homeWxml, /session\.role !== 'teacher'/);
  assert.match(homeJs, /pages\/records\/index\?type=/);
  assert.match(homeJs, /pages\/customers\/index/);
  assert.match(homeJs, /pages\/inactive-customers\/index/);
  assert.match(homeJs, /pages\/low-balance-customers\/index/);
  assert.match(homeWxml, /data-type="product"[^>]*bindtap="openQuery"/,
    "product-purchase search must be a distinct HQ query entry");
});

test("customer query keeps the web filter dimensions, role scope, details, and direct page jump", () => {
  const js = read("pages", "customers", "index.js");
  const wxml = read("pages", "customers", "index.wxml");
  const wxss = read("pages", "customers", "index.wxss");
  const customerDetailJs = read("pages", "customer-detail", "index.js");
  const customerDetailWxml = read("pages", "customer-detail", "index.wxml");
  for (const label of ["门店范围", "业务阶段", "客户状态", "建档时间", "客户姓名", "生日", "跳至"]) {
    assert.match(wxml, new RegExp(label), `customer query is missing ${label}`);
  }
  for (const field of ["processStatus", "customerStatus", "startDate", "endDate", "storeId", "cursorCreatedAt", "cursorId"]) {
    assert.match(js, new RegExp(field), `customer query does not send ${field}`);
  }
  assert.match(js, /callStaff\("listStores"\)/);
  assert.match(js, /callFace\("queryStoreCustomers"/);
  assert.doesNotMatch(js, /updateCustomerStatus|toggleCustomerStatus/,
    "customer search stays read-only; status changes belong to the customer profile");
  assert.doesNotMatch(wxml, /状态操作|封存客户|恢复活跃|toggleCustomerStatus/);
  assert.match(customerDetailJs, /callFace\("updateCustomerStatus"/);
  assert.match(customerDetailJs, /savedStatus !== targetStatus/);
  assert.match(customerDetailWxml, /bindtap="toggleCustomerStatus"/);
  assert.match(js, /requireSession\(\["hq", "store"\]\)/,
    "teacher customers remain on the teacher home instead of exposing the store/HQ query page");
  assert.doesNotMatch(wxml, />详情</, "the customer name itself is the detail link; no duplicate detail column");
  assert.match(js, /while \(targetPage > 1 && !stack\[targetPage - 1\]\)/,
    "cursor-backed customer search must fetch through intermediate pages for a direct jump");
  assert.match(js, /const basePayload = this\.scopedPayload\(\)/,
    "direct page discovery must keep one immutable filter snapshot");
  assert.match(js, /if \(epoch !== this\._requestEpoch\) return false;/,
    "customer results must reject stale responses after filters change");
  assert.match(js, /pages\/customer-detail\/index\?customerCode=/);
  assert.match(js, /timeValues: values\(query\.TIME_OPTIONS\), \.\.\.query\.defaultTimeFilter\(\)/,
    "HQ and store customer queries must open on today's Shanghai business date");
  assert.match(js, /resetSearch\(\)[\s\S]*\.\.\.query\.defaultTimeFilter\(\)/,
    "resetting a customer query must return the time range to today");
  assert.match(wxml, /<view class="customer-row customer-head"><text>姓名<\/text><text>充值<\/text><text>核销<\/text><text>门店<\/text><text>生日<\/text><text>业务阶段<\/text><text>建档日期<\/text><text>客户状态<\/text><\/view>/,
    "customer result columns keep recharge and verification after the name and status last");
  assert.match(wxml, /wx:if="\{\{session\.role === 'hq'\}\}" class="field"><text class="field-label">门店范围<\/text>/,
    "HQ customer search must pair store scope with business stage on phones");
  assert.match(wxml, /class="field \{\{session\.role === 'hq' \? '' : 'query-wide'\}\}"><text class="field-label">建档时间<\/text>/,
    "customer date range must pair with status for HQ and span only when the store role would leave a half-row");
  assert.match(wxml, /class="field"><text class="field-label">客户姓名（可单独填写）<\/text>/);
  assert.match(wxml, /class="field"><text class="field-label">生日（可单独填写）<\/text>/,
    "manual customer name and birthday must share one compact phone row");
  assert.match(wxss, /\.query-grid \.field \{ min-width: 0; margin-bottom: 10rpx; \}/);
  assert.match(wxss, /\.query-grid \.input, \.query-grid \.picker \{ min-height: 72rpx;/,
    "customer query controls must use the compact phone density");
  assert.match(wxss, /\.summary-grid view \{[^}]*padding: 10rpx 6rpx;[^}]*border-radius: 14rpx;/,
    "customer result totals must not consume a full information-card height on phones");
  assert.match(wxss, /\.summary-grid text \{ min-height: 34rpx;[^}]*font-size: 18rpx;/);
  assert.match(wxss, /\.customer-table \{ width: auto; min-width: 100%; display: inline-table; table-layout: auto;/,
    "customer result columns must size to their content and scroll only when the content exceeds the viewport");
  assert.match(wxml, /scroll-left="\{\{tableScrollLeft\}\}"/);
  assert.match(js, /resetTableScroll\(\)[\s\S]*tableScrollLeft: 1[\s\S]*tableScrollLeft: 0/,
    "fresh customer results must force a changed scroll value before returning to the left edge");
  assert.match(js, /\}, \(\) => this\.resetTableScroll\(\)\);/,
    "customer query, reset, and pagination return the newly rendered table to its first column");
});

test("recharge, verification, and product query share complete filters and exact order detail links", () => {
  const js = read("pages", "records", "index.js");
  const wxml = read("pages", "records", "index.wxml");
  for (const label of ["产品来源", "门店范围", "项目", "审核状态", "时间范围", "客户姓名", "生日", "跳至"]) {
    assert.match(wxml, new RegExp(label), `business query is missing ${label}`);
  }
  for (const field of ["recordType", "productId", "sourceType", "statusCategory", "verificationType", "rechargeType", "startDate", "endDate", "customerName", "birthDate", "page", "pageSize"]) {
    assert.match(js, new RegExp(field), `business query does not send ${field}`);
  }
  assert.match(js, /callFace\("queryStoreBusinessRecords"/);
  assert.match(js, /callStaff\("listRetailProductPurchaseReviews"/);
  assert.match(js, /\{ label: "产品购买", value: "PURCHASE" \}/);
  assert.match(js, /\{ label: "充值赠送", value: "GIFT" \}/);
  assert.match(js, /pages\/product-purchase-detail\/index\?recordId=/);
  assert.match(js, /sourceType === "GIFT"[\s\S]*pages\/order-detail\/index\?type=recharge&category=RECHARGE/,
    "recharge gifts must open their parent recharge order rather than inventing a gift order");
  assert.match(js, /const payload = this\.buildPayload\(page\)/);
  assert.match(js, /if \(epoch !== this\._requestEpoch\) return;/,
    "business queries must reject stale responses after filters change");
  assert.match(js, /pages\/order-detail\/index\?type=/);
  assert.match(js, /timeValues: values\(query\.TIME_OPTIONS\), \.\.\.query\.defaultTimeFilter\(\)/,
    "HQ and store business queries must open on today's Shanghai business date");
  assert.match(js, /resetQuery\(\)[\s\S]*\.\.\.query\.defaultTimeFilter\(\)/,
    "resetting recharge, refund, verification, or product queries must return to today");
  assert.match(js, /originalType === "SUPPLEMENT" \? "SUPPLEMENT" : "VERIFICATION"/,
    "verification query links preserve historical supplement category for exact detail reads");
  assert.match(js, /originalType === "VOID" \? "VOID" : "RECHARGE"/,
    "recharge query links preserve historical void category for exact detail reads");
  assert.match(wxml, /bindtap="openRecord"/);
  assert.match(wxml, /class="[^"]*table-link record-code"/);
  const wxss = read("pages", "records", "index.wxss");
  assert.match(wxss, /\.record-table, \.verification-table, \.product-purchase-table \{ width: auto; min-width: 100%; display: inline-table; table-layout: auto;/,
    "all business result tables must size columns from their content and scroll only when needed");
  assert.match(wxss, /\.record-row text \{[^}]*display:\s*table-cell;[^}]*font-size:\s*21rpx;[^}]*white-space:\s*nowrap;/,
    "business result cells must keep one readable font size without clipping long values");
  assert.match(wxml, /scroll-left="\{\{tableScrollLeft\}\}"/,
    "each query result can force the horizontal table back to its first column");
  assert.match(js, /resetTableScroll\(\)[\s\S]*tableScrollLeft: 1[\s\S]*tableScrollLeft: 0/,
    "queries force a changed scroll value before returning the table to its first column");
  assert.match(js, /\}, \(\) => this\.resetTableScroll\(\)\);/,
    "queries, reset, and pagination reset the newly rendered horizontal table");
  const recordCodeRule = wxss.match(/\.record-row \.record-code \{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(recordCodeRule, /font-size\s*:/,
    "query order codes must use the same readable font size as the rest of the table body");
  assert.match(wxml, /<text wx:if="\{\{recordType !== 'VERIFICATION'\}\}"[^>]*>状态<\/text>/,
    "completed verification query results must not repeat a status column");
  assert.match(wxml, /<text wx:if="\{\{recordType !== 'VERIFICATION'\}\}"[^>]*>\{\{item\.statusLabel\}\}<\/text>/,
    "verification rows must omit the redundant completed label while other records keep status");
  assert.match(wxml, /<view wx:if="\{\{recordType !== 'VERIFICATION'\}\}" class="summary-grid">/,
    "review-state summary cards belong to recharge/refund and product purchases, not completed verification queries");
  assert.match(wxml, /recordType === 'PRODUCT_PURCHASE' \? '产品' : '项目'/);
  assert.match(wxml, />来源<\/text>/,
    "the combined product query must visibly distinguish purchases from recharge gifts");
  assert.match(wxml, /summary\.purchase/);
  assert.match(wxml, /summary\.gift/);
  assert.match(wxml, /wx:if="\{\{session\.role === 'hq'\}\}" class="field"><text class="field-label">门店范围<\/text>/,
    "HQ business search must pair store scope with project or product on phones");
  assert.match(wxml, /class="field"><text class="field-label">\{\{recordType === 'PRODUCT_PURCHASE' \? '产品' : '项目'\}\}<\/text>/);
  assert.match(wxml, /class="field query-time \{\{session\.role === 'hq' \? 'query-wide' : ''\}\}"><text class="field-label">时间范围<\/text>/,
    "store searches must use the spare half-row for time while HQ keeps the balanced full-width time row");
  assert.match(wxml, /class="field"><text class="field-label">客户姓名（可单独填写）<\/text>/);
  assert.match(wxml, /class="field"><text class="field-label">生日（可单独填写）<\/text>/,
    "manual business customer lookup must keep name and birthday together");
  assert.match(wxss, /\.query-grid \.field \{ min-width: 0; margin-bottom: 10rpx; \}/);
  assert.match(wxss, /\.query-grid \.input, \.query-grid \.picker \{ min-height: 72rpx;/);
  assert.match(wxss, /\.query-actions button \{ min-height: 72rpx; font-size: 23rpx; \}/,
    "business query and reset actions must match the compact phone control density");
  assert.match(wxss, /\.summary-grid view \{[^}]*padding: 10rpx 6rpx;[^}]*border-radius: 14rpx;/,
    "business status totals must use compact phone tiles above the results");
});

test("order detail uses safe exact reads and exposes authorized verification originals", () => {
  const js = read("pages", "order-detail", "index.js");
  const wxml = read("pages", "order-detail", "index.wxml");
  const api = read("services", "api.js");
  const env = read("config", "env.js");
  assert.match(js, /callStaff\("listReviewOrders"/);
  assert.match(js, /detailRead:\s*true/);
  assert.match(js, /callFace\("getTeacherWorkspace"/);
  assert.match(js, /callPhoto\("getVerificationPhotos"/);
  assert.match(js, /callPhoto\("getVerificationPhotoOriginalUrl"/);
  assert.match(api, /config\.photoFunction/);
  assert.match(env, /photoFunction:\s*"verificationPhoto"/);
  assert.match(js, /require\("\.\.\/\.\.\/services\/photo-album"\)/);
  assert.match(js, /saveImageToAlbum/);
  assert.doesNotMatch(js, /wx\.saveImageToPhotosAlbum/,
    "order pages must use the shared permission-retry album helper");
  assert.match(wxml, /数据库原单/);
  assert.match(wxml, /核销照片/);
});

test("customer history and role homes link exact records to the shared detail page", () => {
  const customerJs = read("pages", "customer-detail", "index.js");
  const customerWxml = read("pages", "customer-detail", "index.wxml");
  const homeJs = read("pages", "home", "index.js");
  const homeWxml = read("pages", "home", "index.wxml");
  assert.match(customerWxml, /bindtap="openOrder"/);
  assert.match(customerJs, /originalType === "SUPPLEMENT" \? "SUPPLEMENT" : "VERIFICATION"/,
    "customer history must not route historical supplements as normal verification");
  assert.match(customerJs, /\["RECHARGE", "REFUND", "VOID"\]\.includes\(category\)/,
    "recharge, refund, and historical void orders keep the recharge family");
  assert.match(customerJs, /pages\/order-detail\/index/);
  assert.match(homeWxml, /bindtap="openOrder"/);
  assert.match(homeJs, /dashboard\.TYPE_CONFIG\[category\]/);
  assert.match(homeWxml, /data-category="\{\{item\.category\}\}"/,
    "home rows carry their immutable category instead of whichever tab is currently selected");
  assert.match(homeWxml, /class="table-pagination business-pagination"[\s\S]*bindtap="jumpBusinessPage"/,
    "store and teacher business history retain direct page jumping on mobile");
});

test("shared query helpers preserve Shanghai business ranges while retired statuses stay out of filters", () => {
  const today = tools.businessToday();
  assert.equal(tools.TIME_OPTIONS[0].value, "TODAY");
  assert.deepEqual(tools.timeRange("TODAY"), { startDate: today, endDate: today });
  assert.deepEqual(tools.defaultTimeFilter(), {
    timeIndex: 0, startDate: today, endDate: today, customRange: false
  });
  assert.deepEqual(tools.timeRange("ALL"), { startDate: "", endDate: "" });
  const week = tools.timeRange("LAST_7");
  assert.match(week.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(week.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(week.startDate <= week.endDate);
  assert.ok(!tools.STATUS_OPTIONS.some((item) => item.value === "CLOSED"));
  assert.ok(tools.VERIFICATION_TYPES.some((item) => item.value === "SUPPLEMENT"));
  assert.ok(!tools.RECHARGE_TYPES.some((item) => item.value === "VOID"));
  const row = tools.normalizeRecord({
    id: "9", recordCode: "R9", originalType: "REFUND", recordStatus: "APPROVED",
    customerName: "测试", birthDate: "2020-01-02", submittedAt: "2026-08-25T00:00:00.000Z"
  }, "RECHARGE");
  assert.equal(row.typeLabel, "退费申请");
  assert.equal(row.statusLabel, "审核通过");
  assert.equal(row.submittedAt, "2026-08-25 08:00");
  assert.equal(tools.displayDateTime("2026-08-27 12:34:56+00"), "2026-08-27 20:34");
  assert.equal(tools.displayDateTime("2026-08-27 12:34:56.123456Z"), "2026-08-27 20:34",
    "iPhone WeChat must accept PostgreSQL microsecond precision after normalization to milliseconds");
  assert.equal(tools.displayDateTime("2026-08-27 20:34:56+08"), "2026-08-27 20:34");
  assert.equal(tools.displayDateTime({ value: "2026-08-27T12:34:56.000Z" }), "2026-08-27 20:34");
  assert.equal(tools.displayDateTime({ seconds: 1787834096, nanoseconds: 0 }), "2026-08-27 20:34");
  assert.equal(tools.displayDateTime(new Date("2026-08-27T12:34:56.000Z")), "2026-08-27 20:34",
    "database driver Date objects must survive the shared formatter");
  assert.equal(tools.displayDateTime({ $date: { $numberLong: "1787834096000" } }), "2026-08-27 20:34",
    "CloudBase extended JSON dates must not become a missing-time dash");
  assert.equal(tools.displayDateTime({ seconds: { $numberLong: "1787834096" }, nanoseconds: { $numberInt: "0" } }), "2026-08-27 20:34",
    "wrapped timestamp seconds must render on iPhone WeChat");
  assert.equal(tools.displayDateTime('{"$date":{"$numberLong":"1787834096000"}}'), "2026-08-27 20:34",
    "stringified CloudBase date wrappers must be decoded once");
  assert.equal(tools.displayDateTimeAny({}, null, "2026-08-27T12:34:56.000Z"), "2026-08-27 20:34",
    "an invalid first alias must not hide a valid later time alias");
  assert.equal(tools.displayDateAny({ $date: { $numberLong: "1787834096000" } }), "2026-08-27",
    "date-only cells share the same wrapper compatibility");
  assert.equal(tools.displayDate("2026-08-26T18:30:00.000Z"), "2026-08-27",
    "timestamp-backed date cells must use the Shanghai calendar day");
  assert.equal(tools.normalizeRecord({ submittedAt: {}, submitted_at: "2026-08-27T12:34:56.000Z" }).submittedAt, "2026-08-27 20:34",
    "query results must try every server alias before showing a dash");
  const completedVerification = tools.normalizeRecord({
    id: "10", recordCode: "V10", originalType: "NORMAL", recordStatus: "APPROVED"
  }, "VERIFICATION");
  const reviewedSupplement = tools.normalizeRecord({
    id: "11", recordCode: "V11", originalType: "SUPPLEMENT", recordStatus: "APPROVED"
  }, "VERIFICATION");
  assert.equal(completedVerification.statusLabel, "已完成");
  assert.equal(reviewedSupplement.statusLabel, "审核通过");
  assert.equal(tools.statusLabel("CLOSED"), "已关闭");
  const purchase = tools.normalizeProductPurchaseRecord({
    id: "12", purchase_code: "PP20260828000001", record_status: "APPROVED",
    unit_count: 3, customer_name: "测试", birth_date: "2020-01-02",
    store_name: "测试门店", product_name_snapshot: "面霜", teacher_name: "苗苗",
    submitted_at: "2026-08-27T12:34:56.000Z"
  });
  assert.equal(purchase.recordCode, "PP20260828000001");
  assert.equal(purchase.productName, "面霜");
  assert.equal(purchase.unitCount, 3);
  assert.equal(purchase.submittedAt, "2026-08-27 20:34");
  assert.equal(purchase.sourceType, "PURCHASE");
  assert.equal(purchase.sourceLabel, "产品购买");
  const gift = tools.normalizeProductPurchaseRecord({
    source_type: "GIFT", source_line_id: "88", record_id: "66",
    record_code: "RC202608280001", product_name_snapshot: "面霜", unit_count: 2
  });
  assert.equal(gift.recordCode, "RC202608280001");
  assert.equal(gift.detailRecordId, "66");
  assert.equal(gift.sourceLabel, "充值赠送");
  assert.equal(gift.originalType, "RECHARGE_GIFT");
});

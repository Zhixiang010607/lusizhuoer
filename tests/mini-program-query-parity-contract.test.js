"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");
const tools = require(path.join(mini, "services", "query-tools.js"));

test("HQ and store mini-program navigation exposes all three database searches", () => {
  const homeJs = read("pages", "home", "index.js");
  const homeWxml = read("pages", "home", "index.wxml");
  for (const label of ["客户查询", "充值查询", "核销查询"]) assert.match(homeWxml, new RegExp(label));
  assert.match(homeWxml, /session\.role !== 'teacher'/);
  assert.match(homeJs, /pages\/records\/index\?type=/);
  assert.match(homeJs, /pages\/customers\/index/);
});

test("customer query keeps the web filter dimensions, role scope, details, and direct page jump", () => {
  const js = read("pages", "customers", "index.js");
  const wxml = read("pages", "customers", "index.wxml");
  for (const label of ["门店范围", "业务阶段", "客户状态", "建档时间", "客户姓名", "生日", "跳至", "封存客户", "恢复活跃"]) {
    assert.match(wxml, new RegExp(label), `customer query is missing ${label}`);
  }
  for (const field of ["processStatus", "customerStatus", "startDate", "endDate", "storeId", "cursorCreatedAt", "cursorId"]) {
    assert.match(js, new RegExp(field), `customer query does not send ${field}`);
  }
  assert.match(js, /callStaff\("listStores"\)/);
  assert.match(js, /callFace\("queryStoreCustomers"/);
  assert.match(js, /callFace\("updateCustomerStatus"/);
  assert.match(js, /expectedStatus:\s*currentStatus/);
  assert.match(wxml, /catchtap="toggleCustomerStatus"/);
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
});

test("recharge and verification query share complete filters and exact order detail links", () => {
  const js = read("pages", "records", "index.js");
  const wxml = read("pages", "records", "index.wxml");
  for (const label of ["门店范围", "项目", "审核状态", "时间范围", "客户姓名", "生日", "跳至"]) {
    assert.match(wxml, new RegExp(label), `business query is missing ${label}`);
  }
  for (const field of ["recordType", "productId", "statusCategory", "verificationType", "rechargeType", "startDate", "endDate", "customerName", "birthDate", "page", "pageSize"]) {
    assert.match(js, new RegExp(field), `business query does not send ${field}`);
  }
  assert.match(js, /callFace\("queryStoreBusinessRecords"/);
  assert.match(js, /const payload = this\.buildPayload\(page\)/);
  assert.match(js, /if \(epoch !== this\._requestEpoch\) return;/,
    "business queries must reject stale responses after filters change");
  assert.match(js, /pages\/order-detail\/index\?type=/);
  assert.match(wxml, /bindtap="openRecord"/);
  assert.match(wxml, /class="table-link record-code"/);
  const wxss = read("pages", "records", "index.wxss");
  assert.match(wxss, /\.record-row \.record-code \{[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;[^}]*white-space:\s*nowrap;/,
    "query order codes remain complete on one line instead of being ellipsized");
  const recordCodeRule = wxss.match(/\.record-row \.record-code \{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(recordCodeRule, /font-size\s*:/,
    "query order codes must use the same readable font size as the rest of the table body");
  assert.match(wxss, /\.record-table \{\s*width:\s*1560rpx;\s*min-width:\s*1560rpx;/,
    "the widened recharge table width equals its visible column widths");
  assert.match(wxss, /\.verification-table \{\s*width:\s*1720rpx;\s*min-width:\s*1720rpx;/,
    "the widened verification table width equals its visible column widths");
  assert.match(wxml, /<view wx:if="\{\{recordType === 'RECHARGE'\}\}" class="summary-grid">/,
    "review-state summary cards belong to recharge/refund only and stay hidden on verification queries");
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
  assert.match(customerJs, /category === "RECHARGE" \|\| category === "REFUND"/);
  assert.match(customerJs, /pages\/order-detail\/index/);
  assert.match(homeWxml, /bindtap="openOrder"/);
  assert.match(homeJs, /dashboard\.TYPE_CONFIG\[category\]/);
});

test("shared query helpers preserve Shanghai business ranges and historical audit filters", () => {
  assert.deepEqual(tools.timeRange("ALL"), { startDate: "", endDate: "" });
  const week = tools.timeRange("LAST_7");
  assert.match(week.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(week.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(week.startDate <= week.endDate);
  assert.ok(tools.STATUS_OPTIONS.some((item) => item.value === "CLOSED"));
  assert.ok(tools.VERIFICATION_TYPES.some((item) => item.value === "SUPPLEMENT"));
  assert.ok(tools.RECHARGE_TYPES.some((item) => item.value === "VOID"));
  const row = tools.normalizeRecord({
    id: "9", recordCode: "R9", originalType: "REFUND", recordStatus: "APPROVED",
    customerName: "测试", birthDate: "2020-01-02", submittedAt: "2026-08-25T00:00:00.000Z"
  }, "RECHARGE");
  assert.equal(row.typeLabel, "退费申请");
  assert.equal(row.statusLabel, "审核通过");
  assert.equal(row.submittedAt, "2026-08-25 08:00");
  const completedVerification = tools.normalizeRecord({
    id: "10", recordCode: "V10", originalType: "NORMAL", recordStatus: "APPROVED"
  }, "VERIFICATION");
  const reviewedSupplement = tools.normalizeRecord({
    id: "11", recordCode: "V11", originalType: "SUPPLEMENT", recordStatus: "APPROVED"
  }, "VERIFICATION");
  assert.equal(completedVerification.statusLabel, "已完成");
  assert.equal(reviewedSupplement.statusLabel, "审核通过");
  assert.equal(tools.statusLabel("CLOSED"), "已关闭");
});

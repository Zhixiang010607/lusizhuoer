"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const app = read("miniprogram-app/miniprogram/app.json");
const homeJs = read("miniprogram-app/miniprogram/pages/home/index.js");
const homeWxml = read("miniprogram-app/miniprogram/pages/home/index.wxml");
const pageJs = read("miniprogram-app/miniprogram/pages/inactive-customers/index.js");
const pageWxml = read("miniprogram-app/miniprogram/pages/inactive-customers/index.wxml");
const pageWxss = read("miniprogram-app/miniprogram/pages/inactive-customers/index.wxss");

function functionSource(name, nextName) {
  const start = cloud.indexOf(`async function ${name}`);
  const end = cloud.indexOf(`\nfunction ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source must exist`);
  return cloud.slice(start, end);
}

test("server applies the fixed NORMAL then EXPERIENCE then customer-created baseline ladder", () => {
  const source = functionSource("queryInactiveVerificationCustomers", "lowBalanceCursor");
  assert.match(source, /activeScopedQueryCaller\(event\)/,
    "HQ may select a verified store while stores remain pinned to their own scope");
  assert.match(source, /minimumDays < 1 \|\| minimumDays > 3650/);
  assert.match(source, /v\.record_status = 'APPROVED'/);
  assert.match(source, /v\.verification_type IN \('NORMAL', 'EXPERIENCE'\)/);
  assert.match(source, /ORDER BY CASE WHEN v\.verification_type = 'NORMAL' THEN 0 ELSE 1 END ASC,[\s\S]*v\.submitted_at DESC, v\.id DESC/,
    "any NORMAL history outranks EXPERIENCE, and only the newest row inside the chosen tier is used");
  assert.match(source, /COALESCE\(latest\.submitted_at, c\.created_at\) AS baseline_at/,
    "customers without either verification type must fall back to customer creation time");
  assert.match(source, /CASE WHEN latest\.id IS NULL THEN 'CUSTOMER_CREATED' ELSE latest\.verification_type END AS baseline_source/);
  assert.match(source, /CURRENT_TIMESTAMP AT TIME ZONE 'Asia\/Shanghai'/,
    "the user-entered interval must be calculated in the business timezone");
  assert.match(source, /scopedStoreClause\(caller, "c\.created_store_id"\)/);
  assert.match(source, /c\.customer_status = 'ACTIVE'/,
    "archived customers must be excluded at the authoritative server boundary");
  assert.match(source, /FROM public\.customer_product_balances balance[\s\S]*balance\.customer_id = c\.id[\s\S]*balance\.remaining_count <> 0/,
    "active-warning classification must be customer-level and use authoritative remaining balances");
  assert.match(source, /THEN 'NONZERO' ELSE 'ZERO' END AS balance_category/,
    "customers with no nonzero balance, including customers without balance rows, belong to the all-zero class");
  assert.match(source, /inactive\.balance_category = 'ZERO'/);
  assert.match(source, /inactive\.balance_category = 'NONZERO'/);
  assert.match(source, /COUNT\(\*\) FILTER \(WHERE balance_category = 'ZERO'\) AS zero_balance_customers/);
  assert.match(source, /COUNT\(\*\) FILTER \(WHERE balance_category = 'NONZERO'\) AS nonzero_balance_customers/);
  assert.match(source, /categoryTotal: category === "ZERO"/);
  assert.match(source, /balanceCategory: customer\.balance_category/);
  assert.match(source, /ORDER BY inactive\.baseline_at ASC, inactive\.id ASC/,
    "the longest-inactive customers should be listed first with a stable cursor");
  assert.match(source, /normalBaseline: Number\(summary\.normal_baseline \|\| 0\)/);
  assert.match(source, /experienceBaseline: Number\(summary\.experience_baseline \|\| 0\)/);
  assert.match(source, /neverVerified: Number\(summary\.never_verified \|\| 0\)/);
  assert.doesNotMatch(source, /recharge_records|retail_product_purchase_records/,
    "recharge and product purchase are not part of the verification inactivity baseline");
  assert.match(cloud, /action === "queryInactiveVerificationCustomers"/);
});

test("HQ and store mini-programs expose a manual inactivity query without teacher access", () => {
  assert.match(app, /"root": "pages\/inactive-customers"/);
  assert.match(homeWxml, /data-type="inactive-customer"[^>]*>活跃预警<\/view>/);
  assert.match(homeWxml, /coreMetricsMenuOpen && session\.role !== 'teacher'/);
  assert.match(homeJs, /type === "inactive-customer"[\s\S]*pages\/inactive-customers\/index/);
  assert.match(pageJs, /requireSession\(\["hq", "store"\]\)/);
  assert.match(pageJs, /callFace\("queryInactiveVerificationCustomers"/);
  assert.match(pageJs, /minimumDays/);
  assert.doesNotMatch(pageJs, /customerStatus|statusIndex|chooseStatus/,
    "the client must not offer an archived-customer option for this query");
  assert.match(pageJs, /storeId/);
  assert.match(pageJs, /cursorBaselineAt/);
  assert.match(pageJs, /cursorCustomerId/);
  assert.match(pageJs, /balanceCategory: category/);
  assert.match(pageJs, /fetchPage\("BOTH", null, basePayload\)/,
    "both customer categories must load from one database snapshot");
  assert.match(pageJs, /zeroCursorStack: \[null\]/);
  assert.match(pageJs, /nonzeroCursorStack: \[null\]/);
  assert.match(pageJs, /while \(targetPage > 1 && !stack\[targetPage - 1\]\)/,
    "direct page jumps must walk the stable server cursor using one filter snapshot");
  assert.match(pageJs, /if \(epoch !== this\._requestEpoch\) return null;/,
    "filter changes must make stale customer responses harmless");
  assert.match(pageJs, /pages\/customer-detail\/index\?customerCode=/);
  assert.match(pageWxml, /核销间隔至少多少天/);
  assert.match(pageWxml, /有正常核销时取最新正常核销；没有正常核销才取最新体验核销；两类都没有时取客户建档时间/);
  for (const label of ["客户", "门店", "间隔时间", "计算起点", "上次核销", "跳至"]) {
    assert.match(pageWxml, new RegExp(label), `inactive-customer results are missing ${label}`);
  }
  assert.doesNotMatch(pageWxml, /起点时间|上次项目|生日/,
    "the compact result must keep only the user-selected five columns");
  assert.match(pageJs, /baselineSource === "CUSTOMER_CREATED"[\s\S]*\? "从未核销"/);
  assert.doesNotMatch(pageWxml, /客户状态|已封存|全部状态/);
  for (const label of ["全部项目为 0", "任意项目非 0", "导出 PDF", "导出 Excel", "1000 位"]) {
    assert.match(pageWxml, new RegExp(label), `inactive customer split/export is missing ${label}`);
  }
  assert.match(pageWxml, /data-category="ZERO" bindtap="previousPage"/);
  assert.match(pageWxml, /data-category="NONZERO" bindtap="previousPage"/);
  assert.match(pageWxss, /\.inactive-table \{ width: auto; min-width: 100%; display: inline-table; table-layout: auto;/);
  assert.match(pageWxss, /\.result-sections \{ display: grid; grid-template-columns: 1fr;/);
  assert.match(pageWxss, /@media \(min-width: 700px\)/,
    "the new query must retain a compact iPad layout");
  assert.match(pageJs, /exportAll: true/);
  assert.match(pageJs, /result\.exportCustomers/,
    "the full export must be returned by one server-side snapshot instead of stitched client pages");
});

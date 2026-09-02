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
const pageJs = read("miniprogram-app/miniprogram/pages/low-balance-customers/index.js");
const pageWxml = read("miniprogram-app/miniprogram/pages/low-balance-customers/index.wxml");
const pageWxss = read("miniprogram-app/miniprogram/pages/low-balance-customers/index.wxss");

function functionSource(name, nextName) {
  const start = cloud.indexOf(`async function ${name}`);
  const end = cloud.indexOf(`\nfunction ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source must exist`);
  return cloud.slice(start, end);
}

test("server queries authoritative opened-card balances and excludes archived customers", () => {
  const source = functionSource("queryLowBalanceCustomers", "optionalBusinessQueryDate");
  assert.match(source, /activeScopedQueryCaller\(event\)/);
  assert.match(source, /remainingBelow < 1 \|\| remainingBelow > 999999/);
  assert.match(source, /FROM public\.customer_product_balances b/,
    "the current balance summary must remain authoritative");
  assert.match(source, /b\.total_recharge_count > 0/,
    "customers who never opened this project must not be synthesized as zero balance");
  assert.match(source, /b\.remaining_count < \$\{remainingBelow\}/,
    "the user asked for strict below-threshold matching");
  assert.match(source, /c\.customer_status = 'ACTIVE'/,
    "archived customers must be excluded at the server boundary");
  assert.match(source, /p\.product_status = 'ACTIVE'/);
  assert.match(source, /scopedStoreClause\(caller, "c\.created_store_id"\)/);
  assert.match(source, /if \(productId\) baseClauses\.push\(`b\.product_id = \$\{productId\}::bigint`\)/,
    "one project and all-project queries must share the same balance contract");
  assert.match(source, /ORDER BY b\.remaining_count ASC, c\.id ASC, b\.product_id ASC/);
  assert.match(source, /COUNT\(DISTINCT c\.id\) AS customer_total/);
  assert.match(source, /COUNT\(DISTINCT b\.product_id\) AS product_total/);
  assert.match(source, /COUNT\(\*\) FILTER \(WHERE b\.remaining_count = 0\) AS zero_balance/);
  assert.doesNotMatch(source, /verification_records|recharge_records/,
    "the query must read the balance state machine rather than re-summing orders");
  assert.match(cloud, /action === "queryLowBalanceCustomers"/);
});

test("HQ and store mini-programs expose project-selectable low-balance search", () => {
  assert.match(app, /"root": "pages\/low-balance-customers"/);
  assert.match(homeWxml, /data-type="low-balance-customer"[^>]*>低余次客户<\/view>/);
  assert.match(homeJs, /type === "low-balance-customer"[\s\S]*pages\/low-balance-customers\/index/);
  assert.match(pageJs, /requireSession\(\["hq", "store"\]\)/);
  assert.match(pageJs, /callStaff\("listStores"\)/);
  assert.match(pageJs, /callStaff\("listProducts"\)/);
  assert.match(pageJs, /product\.status === "ACTIVE"/);
  assert.match(pageJs, /callFace\("queryLowBalanceCustomers"/);
  for (const field of ["remainingBelow", "productId", "storeId", "cursorRemainingCount", "cursorCustomerId", "cursorProductId"]) {
    assert.match(pageJs, new RegExp(field), `low-balance query does not send ${field}`);
  }
  assert.match(pageJs, /while \(targetPage > 1 && !stack\[targetPage - 1\]\)/);
  assert.match(pageJs, /if \(epoch !== this\._requestEpoch\) return false;/);
  assert.match(pageJs, /pages\/customer-detail\/index\?customerCode=/);
  assert.match(pageJs, /productLabels: \["全部项目"\]/);
  for (const label of ["门店范围", "项目范围", "剩余次数低于", "当前剩余", "净开卡", "已核销", "门店", "跳至"]) {
    assert.match(pageWxml, new RegExp(label), `low-balance results are missing ${label}`);
  }
  assert.doesNotMatch(pageWxml, /生日|item\.productCode/,
    "low-balance results must omit birthdays and project codes");
  assert.doesNotMatch(pageJs, /birthDateLabel|product\.code|productCode/,
    "low-balance view models and selectors must not append removed fields");
  assert.match(pageWxml, /只统计已开卡项目，0 次余额会命中，从未开卡不会按 0 次计入/);
  assert.match(pageWxml, /封存客户不参与查询/);
  assert.match(pageWxss, /\.low-balance-table \{ width: auto; min-width: 100%; display: inline-table; table-layout: auto;/);
  assert.match(pageWxss, /@media \(min-width: 700px\)/);
});

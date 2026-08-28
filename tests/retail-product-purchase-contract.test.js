"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const migration = read("database", "migrations", "062_retail_product_purchases.sql");
const consoleMigration = read("database", "cloudbase-console", "062-01-retail-product-purchases.sql");
const consoleVerify = read("database", "cloudbase-console", "062-readonly-verify.sql");
const face = read("cloudfunctions", "faceRecognition", "index.js");
const staff = read("cloudfunctions", "staffAccount", "index.js");
const authUi = read("auth-ui.js");
const storeBusiness = read("store-business.js");
const webCreate = read("product-purchase-create.html");
const webReview = read("product-purchase-review.html");
const webCustomer = read("customer-detail.html");
const miniApp = read("miniprogram-app", "miniprogram", "app.json");
const miniHome = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
const miniCreate = read("miniprogram-app", "miniprogram", "pages", "product-purchase", "index.wxml");
const miniCreateJs = read("miniprogram-app", "miniprogram", "pages", "product-purchase", "index.js");
const miniReview = read("miniprogram-app", "miniprogram", "pages", "reviews", "index.wxml");
const miniCustomer = read("miniprogram-app", "miniprogram", "pages", "customer-detail", "index.wxml");
const miniCustomerJs = read("miniprogram-app", "miniprogram", "pages", "customer-detail", "index.js");
const miniCustomerCss = read("miniprogram-app", "miniprogram", "pages", "customer-detail", "index.wxss");

assert.equal(consoleMigration, migration, "CloudBase console 062 must stay byte-identical to the canonical migration");
assert.match(consoleVerify, /WITH checks AS/);
assert.equal((consoleVerify.match(/UNION ALL/g) || []).length, 4,
  "CloudBase console 062 verification must return all five checks in one result table");
assert.match(consoleVerify, /ORDER BY sort_order/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.retail_product_purchase_records/);
assert.match(migration, /record_status TEXT NOT NULL DEFAULT 'PENDING'/);
assert.match(migration, /role_code NOT IN \('store', 'teacher'\)/, "only store and teacher submitters may write purchase applications");
assert.match(migration, /reviewer\.role_code <> 'hq'/, "only headquarters may review product purchases");
assert.match(migration, /id = NEW\.reviewed_by_account_id/, "the database mutation guard must validate the actual reviewer account");
assert.match(migration, /RETAIL_PRODUCT_PURCHASE_DELETE_FORBIDDEN/, "purchase audit records must not be deletable");
assert.match(migration, /OLD\.record_status <> 'PENDING'/, "review state must be single-transition and immutable afterwards");

assert.match(face, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v9" : "v103"/);
assert.match(face, /async function createRetailProductPurchaseApplication/);
assert.match(face, /const caller = await activeBusinessCaller\(event\)/);
assert.match(face, /const teacherId = caller\.role === "teacher"[\s\S]*positiveDatabaseId\(caller\.teacherId, "老师"\)[\s\S]*requestedTeacherId \? positiveDatabaseId\(requestedTeacherId, "老师"\) : ""/,
  "store product purchases may select a teacher or leave the field empty");
assert.match(face, /action === "createRetailProductPurchaseApplication"/);
assert.match(face, /recordType === "PRODUCT_PURCHASE"/);
assert.match(face, /retailProductSummary:/);
assert.match(face, /productPurchases: mapCustomerProductPurchases/);
assert.match(face, /historyOptions\.type === "PRODUCT_PURCHASE"/);
assert.match(face, /record_status = 'APPROVED'/, "customer purchase totals must include approved purchases only");
assert.match(face, /recharge\.record_status = 'APPROVED'/, "customer gift totals must include approved recharge gifts only");

assert.match(staff, /const FUNCTION_VERSION = "v79"/);
assert.match(staff, /async function listRetailProductPurchaseReviews/);
assert.match(staff, /async function reviewRetailProductPurchase/);
assert.match(staff, /requireReviewer\(caller\)/);
assert.match(staff, /review_retail_product_purchase/);
for (const filter of ["retailProductId", "customerName", "birthDate", "startDate", "endDate"]) {
  assert.match(staff, new RegExp(filter), `HQ product query must support ${filter}`);
}
assert.match(staff, /COUNT\(\*\) FILTER \(WHERE entry\.record_status = 'PENDING'\)/,
  "product query must return a filter-aware review-state summary");
assert.match(staff, /'PURCHASE'::text AS source_type[\s\S]*FROM public\.retail_product_purchase_records purchase/,
  "combined product query must retain independent purchase orders");
assert.match(staff, /FROM public\.recharge_product_gifts gift[\s\S]*JOIN public\.recharge_records recharge/,
  "combined product query must include immutable recharge gift lines");
assert.match(staff, /recharge\.recharge_code AS record_code, 'GIFT'::text AS source_type/,
  "gift rows must expose the parent recharge order code and explicit source");
assert.match(staff, /requestedSourceType[\s\S]*clauses\.push\(`entry\.source_type =/,
  "product query must support an explicit purchase/gift source filter");
assert.match(staff, /COUNT\(\*\) FILTER \(WHERE entry\.source_type = 'PURCHASE'\)/);
assert.match(staff, /COUNT\(\*\) FILTER \(WHERE entry\.source_type = 'GIFT'\)/);
assert.match(staff, /FROM public\.retail_products[\s\S]*productStatus/,
  "product query must return active and archived product choices");

assert.match(webCreate, /data-store-business="product-purchase"/);
assert.match(webCreate, /第一步：查找并确认客户/);
assert.match(webCreate, /id="serviceCustomerSelect"/);
assert.match(webCreate, /第二步：填写购买信息/);
assert.match(webCreate, /id="purchaseProduct"/);
assert.doesNotMatch(webCreate, /人脸照片|faceCapture|faceConsent/, "product purchase must not request face recognition");
assert.match(storeBusiness, /function setupProductPurchase\(\)/);
assert.match(storeBusiness, /setupLookup\(\)/, "web product purchase must reuse the established recharge customer lookup");
assert.match(storeBusiness, /createRetailProductPurchaseApplication/);
assert.match(webReview, /产品购买审核记录/);
assert.match(webCustomer, /产品名称<\/th><th>购买<\/th><th>赠送/);
assert.match(webCustomer, /<h2>产品记录<\/h2>/);

assert.match(authUi, /\["product-purchase-create\.html", "产品购买"\]/);
assert.match(authUi, /product-purchase-review\.html/);
assert.match(miniApp, /"root": "pages\/product-purchase", "pages": \["index"\]/);
assert.match(miniHome, /bindtap="openProductPurchase">产品购买/);
assert.match(miniHome, /data-type="product-purchase" bindtap="openReview">产品购买审核/);
assert.match(miniCreate, /<customer-picker(?: wx:if="\{\{store\.id\}\}")? store-id="\{\{store\.id\}\}"/,
  "mini-program purchase must reuse the established store-scoped customer picker");
assert.match(miniCreate, /第二步：填写购买信息/);
assert.doesNotMatch(miniCreate, /chooseMedia|capturePhoto|faceImage|faceConsent/);
assert.match(miniCreateJs, /requireSession\(\["store", "teacher"\]\)/);
assert.match(miniCreateJs, /createRetailProductPurchaseApplication/);
assert.match(miniReview, /type === 'product-purchase' \? '产品' : '项目'/);
assert.match(miniCreateJs, /createRetailProductPurchaseApplication/);
assert.match(miniCustomer, /产品名称<\/text><text>购买<\/text><text>赠送/);
assert.match(miniCustomer, /data-type="PRODUCT_PURCHASE"[^>]*>产品<\/button>/);
assert.match(miniCustomer, /class="retail-summary-scroll"[\s\S]*scroll-y="\{\{retailSummaryScrollable\}\}"/,
  "customer product summary must scroll inside its card only after the row limit");
assert.match(miniCustomerJs, /visibleRows = Math\.min\(5, retailProductSummary\.length\)/);
assert.match(miniCustomerCss, /grid-template-columns: minmax\(0, 1\.4fr\) repeat\(2, minmax\(110rpx, \.8fr\)\)/,
  "product, purchase, and gift columns must use a compact responsive grid");

console.log("retail product purchase contract: PASS");

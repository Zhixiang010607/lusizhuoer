"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const detailHtml = read("recharge-detail.html");
const queryHtml = read("recharge-query.html");
const reviewHtml = read("recharge-review.html");
const refundReviewHtml = read("refund-review.html");
const authUi = read("auth-ui.js");
const detailUi = read("business-detail.js");
const queryUi = read("query.js");
const reviewUi = read("review.js");
const queryCloud = read("cloudfunctions/faceRecognition/index.js");
const accountCloud = read("cloudfunctions/staffAccount/index.js");
const migration = read("database/migrations/043_disable_recharge_void_workflow.sql");
const consoleMigration = read("database/cloudbase-console/043-01-disable-recharge-void.sql");

assert.match(detailHtml, /<h2 id="reviewPanelTitle">总部审核<\/h2>/);
assert.match(detailHtml, /id="rechargeStoreMessage"[\s\S]*id="rechargeHqMessage"/);
assert.match(detailHtml, /门店原申请留言[\s\S]*总部回复/);
assert.doesNotMatch(detailHtml, /id="storeVoidAction"|id="submitVoidApplication"|<h2>留言记录<\/h2>|id="orderComments"/);
assert.match(detailHtml, /business-detail\.js\?v=0\.16\.18/);
assert.match(detailUi, /function renderRechargeReviewMessages\(record\)/);
assert.match(detailUi, /renderRechargeReviewMessages\(record\);/);
assert.doesNotMatch(detailUi, /setupVoidApplication\(record, normalKind/);

assert.match(queryHtml, /value="PENDING">待审核<\/option><option value="APPROVED">审核通过<\/option><option value="REJECTED">已驳回<\/option>/);
assert.doesNotMatch(queryHtml, /value="CLOSED"|作废状态|record-col-void-status/);
assert.match(queryHtml, /<th>审核状态<\/th>/);
assert.doesNotMatch(queryHtml, /<th>状态<\/th>/);
assert.match(queryHtml, /query\.js\?v=0\.15\.10/);
assert.match(queryUi, /REJECTED: "已驳回"/);
assert.match(queryUi, /APPROVED: "审核通过"/);
assert.doesNotMatch(queryUi, /function voidStatusTag|voidPending|作废待审核/);

assert.doesNotMatch(reviewHtml, /id="reviewType"|退费审核记录|充值 \/ 退费/);
assert.match(reviewHtml, /data-review="recharge"[\s\S]*<h2>充值审核记录<\/h2>/);
assert.match(reviewHtml, /href="refund-review\.html">退费审核<\/a>/);
assert.doesNotMatch(reviewHtml, /href="verification-review\.html">核销审核<\/a>/);
assert.match(refundReviewHtml, /data-review="refund"[\s\S]*<h1>退费审核<\/h1>[\s\S]*<h2>退费审核记录<\/h2>/);
assert.doesNotMatch(refundReviewHtml, /id="reviewType"|充值与退费审核记录/);
assert.doesNotMatch(reviewHtml, /作废充值/);
assert.match(reviewHtml, /value="approved">审核通过<\/option>/);
assert.match(reviewHtml, /review\.js\?v=0\.18\.2/);
assert.match(refundReviewHtml, /review\.js\?v=0\.18\.2/);
assert.match(reviewUi, /if \(pageType === "recharge"\) return "NEW";/);
assert.match(reviewUi, /if \(pageType === "refund"\) return "REFUND";/);
assert.match(reviewUi, /applicationType: applicationTypeFilter\(\)/);
assert.match(reviewUi, /APPROVED: "审核通过"/);
assert.match(authUi, /"recharge-review\.html", "refund-review\.html"/);
assert.match(authUi, /href="refund-review\.html">退费审核/);

assert.match(queryCloud, /\["ALL", "PENDING", "APPROVED", "REJECTED", "CLOSED"\]/);
assert.match(queryCloud, /\["REJECTED", "CLOSED"\]\.includes\(statusCategory\)/);
assert.match(queryCloud, /rejected: Number\(summary\.rejected \|\| 0\)/);
assert.match(accountCloud, /const FUNCTION_VERSION = "v54"/);
assert.match(accountCloud, /const ORDER_VOID_APPLICATIONS_ENABLED = false/);
assert.doesNotMatch(accountCloud, /applicationType: "NEW"/);
assert.match(accountCloud, /"ORDER_VOID_DISABLED"/);
for (const sql of [migration, consoleMigration]) {
  assert.match(sql, /UPDATE public\.recharge_records[\s\S]*WHERE void_request_status = 'PENDING'/);
  assert.match(sql, /CHECK \(void_request_status <> 'PENDING'\)/);
  assert.match(sql, /CREATE TRIGGER trg_reject_recharge_void_transition/);
  assert.match(sql, /order void applications are disabled; historical records are read-only/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.request_order_void/);
}

console.log("recharge review simplification: PASS");

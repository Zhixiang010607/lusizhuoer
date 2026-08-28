"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const faceRecognition = read("cloudfunctions/faceRecognition/index.js");
const staffAccount = read("cloudfunctions/staffAccount/index.js");
const customerDetail = read("miniprogram-app/miniprogram/pages/customer-detail/index.js");
const customerDetailWxml = read("miniprogram-app/miniprogram/pages/customer-detail/index.wxml");
const context = read("PROJECT_CONTEXT.md");

test("customer history keeps gross recharge and approved refunds separate", () => {
  assert.match(
    faceRecognition,
    /recharge\.recharge_type = 'NEW'[\s\S]{0,120}recharge\.record_status = 'APPROVED'[\s\S]{0,80}AS gross_recharge_count/
  );
  assert.match(
    faceRecognition,
    /refund\.recharge_type = 'REFUND'[\s\S]{0,120}refund\.record_status = 'APPROVED'[\s\S]{0,80}AS total_refund_count/
  );
  assert.match(
    faceRecognition,
    /FILTER \(WHERE recharge\.recharge_type = 'NEW'\)[\s\S]{0,100}AS gross_recharge_count/
  );
  assert.match(
    faceRecognition,
    /FILTER \(WHERE recharge\.recharge_type = 'REFUND'\)[\s\S]{0,100}AS total_refund_count/
  );
  assert.match(faceRecognition, /totalRechargeCount: Number\(customer\.gross_recharge_count \|\| 0\)/);
  assert.match(faceRecognition, /totalRefundCount: Number\(customer\.total_refund_count \|\| 0\)/);
  assert.match(faceRecognition, /remainingCount: Number\(row\.remaining_count \|\| 0\)/);

  assert.match(customerDetail, /totalRefundCount: Number\(value\.totalRefundCount \|\| 0\)/);
  assert.match(customerDetail, /totalRefundCount: Number\(row\.totalRefundCount \|\| 0\)/);
  assert.match(customerDetailWxml, /累计充值[\s\S]*累计退费[\s\S]*累计核销[\s\S]*剩余/);
  assert.match(context, /退费不得从该历史数倒减/);
  assert.match(context, /只有当前剩余余额继续采用净口径/);
});

test("headquarters dashboard counts recharge and refund as independent event columns", () => {
  assert.match(
    staffAccount,
    /CASE WHEN r\.recharge_type = 'NEW' THEN r\.unit_count::bigint ELSE 0::bigint END AS recharge_count/
  );
  assert.match(
    staffAccount,
    /CASE WHEN r\.recharge_type = 'REFUND' THEN r\.unit_count::bigint ELSE 0::bigint END AS refund_count/
  );
  assert.match(staffAccount, /COALESCE\(SUM\(recharge_count\), 0\)::bigint AS recharge_count/);
  assert.match(staffAccount, /COALESCE\(SUM\(refund_count\), 0\)::bigint AS refund_count/);
  assert.match(staffAccount, /recharge: Number\(totalRow\.recharge_count \|\| 0\)/);
  assert.match(staffAccount, /refund: Number\(totalRow\.refund_count \|\| 0\)/);
});

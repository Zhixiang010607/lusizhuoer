"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const includes = (source, text, message) => assert.ok(source.includes(text), message || `missing ${text}`);

const auth = read("auth-ui.js");
const business = read("store-business.js");
const face = read("cloudfunctions/faceRecognition/index.js");
const staff = read("cloudfunctions/staffAccount/index.js");
const review = read("review.js");
const detail = read("business-detail.js");
const migration = read("database/migrations/044_refund_application_workflow.sql");
const refundPage = read("refund-create.html");
const teacherRefundPage = read("teacher-refund-create.html");

for (const file of ["refund-create.html", "teacher-refund-create.html"]) assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
includes(auth, '["refund-create.html", "退费申请"]', "store/HQ sidebar exposes refund");
includes(auth, '["refund-create.html", "退费申请"]', "teacher sidebar reuses the shared refund page");
includes(refundPage, 'data-store-business="refund"', "refund page uses refund workflow");
includes(teacherRefundPage, 'data-store-business="refund" data-teacher-business', "teacher refund is store-bound");
for (const html of [refundPage, teacherRefundPage]) {
  includes(html, 'id="rechargeCount"', "refund count field exists");
  includes(html, 'id="refundBalanceSummary"', "refund impact summary exists");
  includes(html, "提交退费申请", "refund submit exists");
}

includes(business, 'applicationType: refundPage ? "REFUND" : "NEW"', "frontend submits explicit refund type");
includes(business, "Math.max(project.remaining - count, 0)", "frontend previews zero-floor balance");
includes(business, "count > Number(project.purchased || 0)", "frontend prevents over-refunding purchased units");

includes(face, 'if (!["NEW", "REFUND"].includes(applicationType))', "cloud function allowlist includes refund");
includes(face, "balance_before_count", "cloud function stores submission snapshot");
includes(face, 'refund ? "退费次数超过该项目尚未退费的总购买次数', "cloud function rejects invalid refund");
includes(staff, "r.recharge_type IN ('NEW', 'REFUND')", "review queue contains recharge and refund only");
includes(review, 'isRefund ? "退费申请"', "review labels refund orders");
includes(detail, '[["退费次数", rechargeCountLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]]', "customer refund detail keeps only count and timestamps");
assert.ok(!detail.includes('["申请时剩余次数"') && !detail.includes('["审核后剩余次数"'), "customer refund detail removes duplicated balance snapshots");

for (const contract of [
  "CHECK (remaining_count = GREATEST(total_recharge_count - total_verification_count, 0))",
  "refund units exceed unrefunded purchased units",
  "GREATEST(current_remaining - recharge_units, 0)::INTEGER",
  "balance_before_count",
  "balance_after_count",
  "recharge_type IN ('NEW', 'VOID', 'REFUND')"
]) includes(migration, contract, `migration 044 missing ${contract}`);

console.log("refund workflow contract: PASS");

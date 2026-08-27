"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const staff = fs.readFileSync(path.join(root, "cloudfunctions", "staffAccount", "index.js"), "utf8");
const readme = fs.readFileSync(path.join(root, "cloudfunctions", "staffAccount", "README.md"), "utf8");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

assert.match(staff, /const FUNCTION_VERSION = "v79"/);
assert.match(readme, /当前版本：`v79`/);

const attribution = functionSource(staff, "reviewOrderTeacherAttributionCondition");
assert.match(attribution, /attribution_submitter\.id = \$\{alias\}\.submitted_by_account_id/,
  "review display must inspect the immutable original submitter");
assert.match(attribution, /role_code = 'store' AND \$\{storeTypeCondition\}/,
  "store attribution must use the store role/type matrix");
assert.match(attribution, /role_code = 'teacher'[\s\S]*attribution_submitter_teacher\.id = \$\{alias\}\.teacher_id[\s\S]*\$\{teacherTypeCondition\}/,
  "teacher attribution must be bound to the submitting teacher profile and allowed type");
assert.match(attribution, /recharge_type IN \('NEW', 'REFUND'\)/,
  "only recharge and refund may display a selected teacher from recharge records");
assert.match(attribution, /verification_type = 'NORMAL'/,
  "store verification attribution is limited to NORMAL");
assert.match(attribution, /verification_type IN \('NORMAL', 'EXPERIENCE'\)/,
  "teacher verification attribution permits NORMAL and EXPERIENCE");
assert.doesNotMatch(attribution, /role_code = '(?:hq|operation)'/,
  "headquarters and retired operation sources must not prove attribution");

const review = functionSource(staff, "listReviewOrders");
assert.match(review, /LEFT JOIN public\.teachers t[\s\S]*ON t\.id = r\.teacher_id[\s\S]*reviewOrderTeacherAttributionCondition\("r", "RECHARGE"\)/,
  "recharge review display must null untrusted teachers without filtering the order");
assert.match(review, /LEFT JOIN public\.teachers t[\s\S]*ON t\.id = v\.teacher_id[\s\S]*reviewOrderTeacherAttributionCondition\("v", "VERIFICATION"\)/,
  "verification review display must null untrusted teachers without filtering the order");
assert.doesNotMatch(review, /(?<!LEFT )JOIN public\.teachers t ON t\.id = v\.teacher_id/,
  "verification history must not disappear when its teacher is absent or untrusted");

const hqEntitlements = functionSource(staff, "getHqTeacherExperienceEntitlements");
assert.ok((hqEntitlements.match(/reviewOrderTeacherAttributionCondition\("usage_verification", "VERIFICATION"\)/g) || []).length >= 2,
  "HQ cumulative experience totals must exclude invalid legacy usage while quota audit history remains intact");
assert.match(hqEntitlements, /usage_verification\.record_status = 'APPROVED'[\s\S]*usage_verification\.verification_type = 'EXPERIENCE'/,
  "only effective EXPERIENCE orders contribute to teacher business totals");

assert.match(readme, /门店来源仅限充值、退费和正常核销/);
assert.match(readme, /老师来源仅限该提交账号本人办理的充值、退费、正常核销和体验核销/);

console.log("staff review teacher attribution contract: PASS");

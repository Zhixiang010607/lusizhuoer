"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cloud = fs.readFileSync(path.join(root, "cloudfunctions", "faceRecognition", "index.js"), "utf8");

assert.match(cloud, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v7" : "v86"/);

const access = cloud.slice(
  cloud.indexOf("function teacherCustomerAccessCondition"),
  cloud.indexOf("function customerStatusCode")
);
const ownership = cloud.slice(
  cloud.indexOf("function teacherBusinessOwnershipCondition"),
  cloud.indexOf("function teacherCustomerAccessCondition")
);
assert.match(ownership, /\$\{alias\}\.teacher_id = \$\{sqlText\(caller\.teacherId\)\}::bigint[\s\S]*\$\{alias\}\.submitted_by_account_id = \$\{sqlText\(caller\.staffId\)\}::bigint/,
  "business ownership must recognize both the bound teacher and exact submitting login account");
assert.match(access, /created_by_account_id = \$\{sqlText\(caller\.staffId\)\}::bigint/,
  "same-account creation grants teacher customer access");
assert.match(access, /teacher_verification[\s\S]*record_status = 'APPROVED'[\s\S]*verification_type IN \('NORMAL', 'EXPERIENCE'\)/,
  "approved normal or experience verification grants teacher customer access");
assert.match(access, /teacher_recharge[\s\S]*record_status = 'APPROVED'[\s\S]*recharge_type IN \('NEW', 'REFUND'\)/,
  "approved recharge or refund grants teacher customer access");

const workspace = cloud.slice(
  cloud.indexOf("async function getTeacherWorkspace"),
  cloud.indexOf("async function deleteFacePerson")
);
assert.match(workspace, /if \(detailMode\)[\s\S]*permitted_customer\.id = \$\{alias\}\.customer_id[\s\S]*teacherCustomerAccessCondition\(caller, "permitted_customer"\)/,
  "teacher order detail reads must authorize at the customer relationship boundary");
assert.match(workspace, /else \{[\s\S]*clauses\.push\(teacherBusinessOwnershipCondition\(caller, alias\)\)/,
  "teacher workspace lists must remain restricted to the current teacher's own records");
assert.match(workspace, /LEFT JOIN public\.teachers business_teacher ON business_teacher\.id = \$\{alias\}\.teacher_id/,
  "cross-teacher detail reads must load the actual business teacher");
assert.match(cloud, /teacherId: String\(row\.teacher_id \|\| teacher\.teacherId \|\| ""\)[\s\S]*teacherCode: String\(row\.teacher_code \|\| teacher\.teacherCode \|\| ""\)[\s\S]*teacherName: String\(row\.teacher_name \|\| teacher\.teacherName \|\| ""\)/,
  "detail responses must never relabel another teacher's order as the viewer's order");

const photoContext = cloud.slice(
  cloud.indexOf("async function verificationPhotoContext"),
  cloud.indexOf("function teacherCustomerAccessCondition")
);
assert.match(photoContext, /teacherBusinessOwnershipCondition\(caller, "v"\)[\s\S]*OR EXISTS[\s\S]*permitted_customer\.id = v\.customer_id[\s\S]*teacherCustomerAccessCondition\(caller, "permitted_customer"\)/,
  "authorized teachers may read another teacher's verification photos for the same customer");
assert.match(photoContext, /String\(record\.submitted_by_account_id\) === String\(caller\.staffId\)[\s\S]*databaseBoolean\(record\.within_edit_window\)/,
  "cross-teacher photo access must remain read-only unless the viewer is the original submitter within the edit window");

const ownerGuard = cloud.slice(
  cloud.indexOf("function requireVerificationPhotoUploadOwner"),
  cloud.indexOf("function verificationPhotoUploadSlot")
);
assert.match(ownerGuard, /String\(context\.record\.submitted_by_account_id\) === String\(context\.caller\.staffId\)/,
  "all photo write operations must retain the exact original-submitter guard");

console.log("teacher customer cross-order read contract: PASS");

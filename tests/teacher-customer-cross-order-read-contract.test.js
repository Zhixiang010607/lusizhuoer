"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cloud = fs.readFileSync(path.join(root, "cloudfunctions", "faceRecognition", "index.js"), "utf8");

assert.match(cloud, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v9" : "v97"/);

const access = cloud.slice(
  cloud.indexOf("function teacherCustomerAccessCondition"),
  cloud.indexOf("function customerStatusCode")
);
const ownership = cloud.slice(
  cloud.indexOf("function teacherBusinessOwnershipCondition"),
  cloud.indexOf("function teacherBusinessAttributionCondition")
);
const attributionSource = cloud.slice(
  cloud.indexOf("function teacherBusinessAttributionSourceCondition"),
  cloud.indexOf("function trustedBusinessTeacherIdSql")
);
const attribution = cloud.slice(
  cloud.indexOf("function teacherBusinessAttributionCondition"),
  cloud.indexOf("function teacherCustomerAccessCondition")
);
assert.match(ownership, /\$\{alias\}\.submitted_by_account_id = \$\{sqlText\(caller\.staffId\)\}::bigint/,
  "write ownership must recognize only the exact submitting login account");
assert.doesNotMatch(ownership, /teacher_id|caller\.teacherId/,
  "write ownership must not expand to the selected teacher");
assert.match(attribution, /\$\{alias\}\.teacher_id = \$\{sqlText\(caller\.teacherId\)\}::bigint/,
  "business attribution must recognize the selected teacher independently of submitter");
assert.match(attribution, /teacherBusinessAttributionSourceCondition\(alias, recordFamily\)/,
  "business attribution must prove a valid store or same-teacher submission source");
assert.match(attributionSource, /attribution_submitter\.id = \$\{alias\}\.submitted_by_account_id[\s\S]*role_code = 'store'[\s\S]*role_code = 'teacher'/,
  "the submitter is consulted only to validate attribution provenance");
assert.match(attributionSource, /verification_type = 'NORMAL'[\s\S]*verification_type IN \('NORMAL', 'EXPERIENCE'\)/,
  "store EXPERIENCE cannot grant attribution while teacher-self EXPERIENCE remains valid");
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
assert.match(workspace, /teacherBusinessOwnershipCondition\(caller, alias\)[\s\S]*record_status = 'APPROVED'[\s\S]*teacherBusinessAttributionCondition\(caller, alias, baseRecordType\)/,
  "pending or rejected attribution grants no direct detail read unless the teacher is the original submitter");
assert.match(workspace, /else if \(legacyCombined\)[\s\S]*teacherBusinessOwnershipCondition\(caller, alias\)[\s\S]*record_status = 'APPROVED'[\s\S]*teacherBusinessAttributionCondition\(caller, alias, baseRecordType\)/,
  "rolling-deployment lists must not expose another submitter's ineffective attributed order");
assert.match(workspace, /else \{[\s\S]*clauses\.push\(teacherBusinessAttributionCondition\(caller, alias, baseRecordType\)\)/,
  "teacher workspace lists must include records attributed to the current teacher");
assert.match(workspace, /business_teacher\.id AS teacher_id[\s\S]*LEFT JOIN public\.teachers business_teacher[\s\S]*business_teacher\.id = \$\{alias\}\.teacher_id/,
  "detail reads must expose the business teacher selected on the order");
assert.doesNotMatch(workspace, /business_teacher\.staff_account_id = \$\{alias\}\.submitted_by_account_id/,
  "store-submitted records must keep their selected teacher in history");
assert.match(workspace, /business_teacher\.id = \$\{alias\}\.teacher_id[\s\S]*teacherBusinessAttributionSourceCondition\(alias, baseRecordType\)/,
  "untrusted HQ or retired-role teacher fields must not appear as a business teacher");
assert.match(cloud, /teacherId: String\(row\.teacher_id \|\| ""\)[\s\S]*teacherCode: String\(row\.teacher_code \|\| ""\)[\s\S]*teacherName: String\(row\.teacher_name \|\| ""\)/,
  "detail responses must expose only the teacher stored on the order");
assert.doesNotMatch(cloud, /row\.teacher_id \|\| teacher\.teacherId|row\.teacher_code \|\| teacher\.teacherCode|row\.teacher_name \|\| teacher\.teacherName/,
  "an unbound HQ order must never be relabelled as the teacher viewing the customer");

const photoContext = cloud.slice(
  cloud.indexOf("async function verificationPhotoContext"),
  cloud.indexOf("function teacherCustomerAccessCondition")
);
assert.match(photoContext, /teacherBusinessOwnershipCondition\(caller, "v"\)[\s\S]*v\.record_status = 'APPROVED'[\s\S]*teacherBusinessAttributionCondition\(caller, "v", "VERIFICATION"\)[\s\S]*OR EXISTS[\s\S]*permitted_customer\.id = v\.customer_id[\s\S]*teacherCustomerAccessCondition\(caller, "permitted_customer"\)/,
  "the selected teacher and other related teachers may read verification photos");
assert.match(photoContext, /String\(record\.submitted_by_account_id\) === String\(caller\.staffId\)[\s\S]*databaseBoolean\(record\.within_edit_window\)/,
  "cross-teacher photo access must remain read-only unless the viewer is the original submitter within the edit window");

const ownerGuard = cloud.slice(
  cloud.indexOf("function requireVerificationPhotoUploadOwner"),
  cloud.indexOf("function verificationPhotoUploadSlot")
);
assert.match(ownerGuard, /String\(context\.record\.submitted_by_account_id\) === String\(context\.caller\.staffId\)/,
  "all photo write operations must retain the exact original-submitter guard");

console.log("teacher customer cross-order read contract: PASS");

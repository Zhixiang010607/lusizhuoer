"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cloud = fs.readFileSync(path.join(root, "cloudfunctions", "faceRecognition", "index.js"), "utf8");
const readme = fs.readFileSync(path.join(root, "cloudfunctions", "faceRecognition", "README.md"), "utf8");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function section(startMarker, endMarker) {
  const start = cloud.indexOf(startMarker);
  const end = cloud.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} section must exist`);
  return cloud.slice(start, end);
}

assert.match(cloud, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v9" : "v96"/);
assert.match(readme, /当前版本：`v96`/);

const attributionSource = section("function teacherBusinessAttributionSourceCondition", "function trustedBusinessTeacherIdSql");
const trustedTeacherId = section("function trustedBusinessTeacherIdSql", "function teacherBusinessOwnershipCondition");
const ownership = section("function teacherBusinessOwnershipCondition", "function teacherBusinessAttributionCondition");
const attribution = section("function teacherBusinessAttributionCondition", "function teacherCustomerAccessCondition");
const customerAccess = section("function teacherCustomerAccessCondition", "function customerProfileScope");

assert.match(attributionSource, /attribution_submitter\.id = \$\{alias\}\.submitted_by_account_id/,
  "historical attribution must validate the original submitter role");
assert.match(attributionSource, /attribution_submitter\.role_code = 'store'/,
  "store-submitted orders may retain their selected business teacher");
assert.match(attributionSource, /attribution_submitter\.role_code = 'teacher'[\s\S]*attribution_submitter_teacher\.id = \$\{alias\}\.teacher_id/,
  "teacher-submitted orders are attributed only when bound to that same teacher");
assert.match(attributionSource, /recordFamily === "RECHARGE"[\s\S]*recharge_type IN \('NEW', 'REFUND'\)/,
  "recharge attribution is restricted to the current NEW and REFUND categories");
assert.match(attributionSource, /verification_type = 'NORMAL'[\s\S]*verification_type IN \('NORMAL', 'EXPERIENCE'\)/,
  "stores may attribute only NORMAL verification while teacher-self EXPERIENCE remains valid");
assert.doesNotMatch(attributionSource, /role_code = '(?:hq|operation)'/,
  "headquarters and retired operation sources must never prove teacher attribution");
assert.match(trustedTeacherId, /teacherBusinessAttributionSourceCondition\(alias, recordFamily\)[\s\S]*\$\{alias\}\.teacher_id[\s\S]*NULL::bigint/,
  "dimension queries must preserve the order while clearing untrusted teacher attribution");
assert.match(ownership, /submitted_by_account_id = \$\{sqlText\(caller\.staffId\)\}::bigint/,
  "write ownership must remain bound to the exact submitting account");
assert.doesNotMatch(ownership, /teacher_id|caller\.teacherId/,
  "being the selected teacher must not grant submitter write ownership");
assert.match(attribution, /teacher_id = \$\{sqlText\(caller\.teacherId\)\}::bigint/,
  "business attribution must use the selected teacher id");
assert.match(attribution, /teacherBusinessAttributionSourceCondition\(alias, recordFamily\)/,
  "business attribution must also prove that the submitter was a store or the same teacher");
assert.match(customerAccess, /teacherBusinessAttributionCondition\(caller, "teacher_verification", "VERIFICATION"\)/,
  "approved attributed verification must grant a teacher-customer relationship");
assert.match(customerAccess, /teacherBusinessAttributionCondition\(caller, "teacher_recharge", "RECHARGE"\)/,
  "approved attributed recharge or refund must grant a teacher-customer relationship");

const recharge = section("async function createRechargeApplication", "async function requireVerificationSubmissionSchema");
assert.match(recharge, /\["NEW", "REFUND"\]\.includes\(applicationType\)/,
  "recharge and refund must share the teacher-selection matrix");
assert.match(recharge, /caller\.role === "teacher"[\s\S]*teacherIdText !== String\(caller\.teacherId\)[\s\S]*"FORBIDDEN"/,
  "teacher submissions must reject attempts to select another teacher");
assert.match(recharge, /const teacherId = caller\.role === "teacher"[\s\S]*positiveDatabaseId\(caller\.teacherId, "老师"\)[\s\S]*teacherIdText \? positiveDatabaseId\(teacherIdText, "老师"\) : null/,
  "teacher submissions bind self while store recharge and refund keep teacher optional");
assert.match(recharge, /t\.teacher_status = 'ACTIVE'[\s\S]*a\.role_code = 'teacher'[\s\S]*a\.account_status = 'ACTIVE'/,
  "a selected teacher must have an active teacher profile and login account");

const verification = section("async function createVerificationApplication", "async function recoverBusinessSubmission");
const requiredTeacher = verification.indexOf('positiveDatabaseId(caller.role === "teacher" ? caller.teacherId : requestedTeacherId, "老师")');
assert.ok(requiredTeacher >= 0,
  "store normal verification must require a selected teacher");
assert.match(verification, /experienceVerification && caller\.role !== "teacher"[\s\S]*"FORBIDDEN"/,
  "store and HQ experience verification must be rejected by role");
assert.match(verification, /caller\.role === "teacher"[\s\S]*requestedTeacherId !== String\(caller\.teacherId\)[\s\S]*"FORBIDDEN"/,
  "teacher verification must reject attempts to select another teacher");
assert.match(verification, /positiveDatabaseId\(caller\.role === "teacher" \? caller\.teacherId : requestedTeacherId, "老师"\)/,
  "store normal verification must require a concrete teacher while teacher verification binds self");
assert.match(verification, /t\.teacher_status = 'ACTIVE'[\s\S]*a\.role_code = 'teacher'[\s\S]*a\.account_status = 'ACTIVE'/,
  "normal verification may only bind a currently active teacher");

const entitlements = section("async function getTeacherExperienceEntitlements", "async function listActiveTeachers");
assert.match(entitlements, /caller\.role !== "teacher"[\s\S]*"FORBIDDEN"/,
  "stores and HQ must not read the EXPERIENCE creation entitlement path");
assert.match(entitlements, /requestedTeacherId && requestedTeacherId !== String\(caller\.teacherId\)[\s\S]*"FORBIDDEN"/,
  "teacher accounts may only read their own experience quota");
assert.match(entitlements, /positiveDatabaseId\(caller\.teacherId, "老师"\)/,
  "experience entitlement reads use the authenticated teacher identity");
assert.match(entitlements, /JOIN public\.verification_records usage_verification[\s\S]*usage_verification\.record_status = 'APPROVED'[\s\S]*usage_verification\.verification_type = 'EXPERIENCE'[\s\S]*teacherBusinessAttributionSourceCondition\("usage_verification", "VERIFICATION"\)/,
  "cumulative teacher experience statistics must exclude legacy store or otherwise invalid usage attribution");

const teacherCustomers = section("async function getTeacherBusinessCustomers", "async function getTeacherWorkspace");
assert.match(teacherCustomers, /teacherBusinessAttributionCondition\(caller, "v", "VERIFICATION"\)/,
  "attributed verification must appear in the selected teacher's customer relationship");
assert.match(teacherCustomers, /teacherBusinessAttributionCondition\(caller, "r", "RECHARGE"\)/,
  "attributed recharge and refund must appear in the selected teacher's customer relationship");

const workspace = section("async function getTeacherWorkspace", "async function deleteFacePerson");
assert.match(workspace, /clauses\.push\(teacherBusinessAttributionCondition\(caller, alias, baseRecordType\)\)/,
  "teacher business lists must use teacher attribution");
assert.match(workspace, /WHERE \$\{teacherBusinessAttributionCondition\(caller, "r", "RECHARGE"\)\}/,
  "teacher recharge and refund summary must use teacher attribution");
assert.match(workspace, /WHERE \$\{teacherBusinessAttributionCondition\(caller, "v", "VERIFICATION"\)\}/,
  "teacher normal and experience summary must use teacher attribution");
assert.doesNotMatch(workspace, /business_teacher\.staff_account_id = \$\{alias\}\.submitted_by_account_id/,
  "historical teacher display must not disappear for store-submitted business");
assert.match(workspace, /teacherBusinessOwnershipCondition\(caller, alias\)[\s\S]*record_status = 'APPROVED'[\s\S]*teacherBusinessAttributionCondition\(caller, alias, baseRecordType\)/,
  "pending and rejected orders must not grant a selected teacher direct detail access");
assert.match(workspace, /else if \(legacyCombined\)[\s\S]*teacherBusinessOwnershipCondition\(caller, alias\)[\s\S]*record_status = 'APPROVED'[\s\S]*teacherBusinessAttributionCondition\(caller, alias, baseRecordType\)/,
  "legacy combined lists expose ineffective orders only to their original teacher submitter");
assert.match(workspace, /business_teacher\.id = \$\{alias\}\.teacher_id[\s\S]*teacherBusinessAttributionSourceCondition\(alias, baseRecordType\)/,
  "historical display must suppress untrusted headquarters and retired-role teacher fields");

const profile = section("async function getCustomerProfile", "async function getCustomerPhotoUrl");
assert.match(profile, /business_teacher\.id = r\.teacher_id/,
  "recharge and refund history must display the selected teacher");
assert.match(profile, /business_teacher\.id = v\.teacher_id/,
  "verification history must display the selected teacher");
assert.doesNotMatch(profile, /business_teacher\.staff_account_id = [rv]\.submitted_by_account_id/,
  "historical display must be independent from the submitter account");
assert.ok((profile.match(/teacherBusinessAttributionSourceCondition\("r", "RECHARGE"\)|teacherBusinessAttributionSourceCondition\("v", "VERIFICATION"\)/g) || []).length >= 2,
  "both recharge and verification history must hide untrusted legacy teacher fields");

const storeAnalytics = section("function storeAnalyticsEventCte", "function storeAnalyticsCounts");
assert.ok((storeAnalytics.match(/trustedBusinessTeacherIdSql\("r", "RECHARGE"\)|trustedBusinessTeacherIdSql\("v", "VERIFICATION"\)/g) || []).length >= 2,
  "store teacher dimensions must not attribute legacy headquarters or retired-role events");

const photoContext = section("async function verificationPhotoContext", "function teacherBusinessOwnershipCondition");
assert.match(photoContext, /teacherBusinessOwnershipCondition\(caller, "v"\)[\s\S]*v\.record_status = 'APPROVED'[\s\S]*teacherBusinessAttributionCondition\(caller, "v", "VERIFICATION"\)/,
  "an attributed teacher may read the related verification photos");
assert.match(photoContext, /String\(record\.submitted_by_account_id\) === String\(caller\.staffId\)[\s\S]*databaseBoolean\(record\.within_edit_window\)/,
  "photo editing must remain exclusive to the original submitter and edit window");

const photoOwner = section("function requireVerificationPhotoUploadOwner", "function verificationPhotoUploadSlot");
assert.match(photoOwner, /String\(context\.record\.submitted_by_account_id\) === String\(context\.caller\.staffId\)/,
  "supplemental photo writes must remain exclusive to the original submitter");

const recovery = section("async function recoverBusinessSubmission", "async function getCustomerProductBalances");
assert.ok((recovery.match(/String\(record\.submitted_by_account_id\) !== String\(caller\.staffId\)/g) || []).length >= 2,
  "both recharge and verification recovery must remain exclusive to the original submitter");
assert.ok((recovery.match(/teacherBusinessAttributionSourceCondition\("r", "RECHARGE"\)|teacherBusinessAttributionSourceCondition\("v", "VERIFICATION"\)/g) || []).length >= 2,
  "recovery responses must not display an untrusted legacy business teacher");

assert.match(readme, /有效 `teacher_id` 是老师统计、老师客户关系和历史业务老师显示的归属依据/);
assert.match(readme, /`submitted_by_account_id` 仍是改单、补充照片、作废、撤销和提交恢复的唯一写权限依据/);

const migration059 = read("database/migrations/059_business_teacher_attribution.sql");
const prerequisites059 = read("database/cloudbase-console/059-00-store-binding-prerequisites.sql");
const console059Function = read("database/cloudbase-console/059-01-business-teacher-function.sql");
const console059Triggers = read("database/cloudbase-console/059-02-business-teacher-triggers.sql");
const preflight059 = read("database/cloudbase-console/059-preflight-business-teacher-attribution.sql");
const layoutPreflight059 = read("database/cloudbase-console/059-preflight-store-binding-layout.sql");
const verify059 = read("database/cloudbase-console/059-readonly-verify.sql");
const layoutVerify059 = read("database/cloudbase-console/059-readonly-verify-store-binding.sql");
const readme059 = read("database/cloudbase-console/059-README.md");

for (const sql of [migration059, console059Function]) {
  assert.match(sql, /BUSINESS_TEACHER_MATRIX_V59/);
  assert.match(sql, /STORE_RECHARGE_REFUND_TEACHER_OPTIONAL_V59/,
    "store recharge and refund keep optional teacher attribution");
  assert.match(sql, /STORE_NORMAL_TEACHER_REQUIRED_V59/,
    "store normal verification requires an active teacher at the database boundary");
  assert.match(sql, /STORE_EXPERIENCE_DENIED_V59/,
    "store EXPERIENCE must be denied at the database boundary");
  assert.match(sql, /TEACHER_SELF_ATTRIBUTION_V59/,
    "teacher writes must remain self-attributed");
  assert.match(sql, /FOR SHARE OF t, a/,
    "selected teacher and account are locked against concurrent archival");
  assert.match(sql, /IF has_direct THEN[\s\S]*STORE_BINDING_CURRENT_V59[\s\S]*ELSIF TO_REGCLASS\('public\.staff_store_assignments'\)/,
    "stores.store_account_id must take priority over the legacy binding table");
  assert.match(sql, /STORE_BINDING_CURRENT_V59[\s\S]*store_account_id = \$2[\s\S]*store_status = ''ACTIVE''/,
    "the current binding layout must lock an active directly-bound store");
  assert.match(sql, /STORE_BINDING_LEGACY_V59[\s\S]*assignment_status = ''ACTIVE''[\s\S]*store_status = ''ACTIVE''/,
    "the legacy fallback must lock both an active assignment and active store");
  assert.match(sql, /STORE_BINDING_DYNAMIC_V59[\s\S]*EXECUTE scope_sql INTO scope_ok/,
    "optional store layouts must only be referenced through dynamic SQL");
  assert.doesNotMatch(sql, /PERFORM\s+1\s+FROM\s+public\.staff_store_assignments/,
    "the trigger function must not statically reference the optional legacy table");
}

const canonicalFunction = migration059.match(/CREATE OR REPLACE FUNCTION public\.enforce_business_teacher_matrix_v59\(\)[\s\S]*?REVOKE ALL ON FUNCTION public\.enforce_business_teacher_matrix_v59\(\) FROM PUBLIC;/)?.[0];
const consoleFunction = console059Function.match(/CREATE OR REPLACE FUNCTION public\.enforce_business_teacher_matrix_v59\(\)[\s\S]*?REVOKE ALL ON FUNCTION public\.enforce_business_teacher_matrix_v59\(\) FROM PUBLIC;/)?.[0];
assert.ok(canonicalFunction && consoleFunction, "canonical and console guard definitions must exist");
assert.equal(consoleFunction, canonicalFunction,
  "canonical and CloudBase console guard definitions must stay byte-for-byte aligned");

const canonicalPrerequisites = migration059.slice(0, migration059.indexOf("CREATE OR REPLACE FUNCTION"));
for (const sql of [canonicalPrerequisites, prerequisites059]) {
  assert.match(sql, /TO_REGCLASS\('public\.stores'\) IS NULL/,
    "the stores table is a required 059 prerequisite");
  assert.doesNotMatch(sql, /OR\s+TO_REGCLASS\('public\.staff_store_assignments'\) IS NULL/,
    "the rebuilt schema must not require the retired assignment table");
  assert.match(sql, /column_name IN \('id', 'store_status'\)\) <> 2/,
    "both binding layouts require a store id and active-status column");
  assert.match(sql, /column_name = 'store_account_id'[\s\S]*IF NOT has_direct_store_binding[\s\S]*TO_REGCLASS\('public\.staff_store_assignments'\)/,
    "legacy layout is accepted only when the direct store binding column is absent");
}

const consoleSqlFiles = [
  prerequisites059, console059Function, console059Triggers,
  preflight059, layoutPreflight059, verify059, layoutVerify059
];
for (const sql of consoleSqlFiles) {
  const windowsLineEndings = sql.replace(/\n/g, "\r\n");
  assert.ok(Buffer.byteLength(windowsLineEndings) < 3500,
    "every 059 CloudBase SQL file must retain safe editor and line-ending headroom");
}
assert.match(console059Triggers, /trg_058_recharge_integrity[\s\S]*trg_058_verification_integrity/,
  "059 installation requires both enabled migration 058 integrity triggers");
assert.match(console059Triggers, /BEFORE INSERT ON public\.recharge_records/);
assert.match(console059Triggers, /BEFORE INSERT ON public\.verification_records/);

for (const sql of [preflight059, layoutPreflight059, verify059, layoutVerify059]) {
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i,
    "059 preflight and verification files must remain read-only");
}
assert.match(layoutPreflight059, /current store binding layout[\s\S]*legacy store binding layout[\s\S]*selected store binding layout/,
  "layout preflight must report current, legacy, and selected binding readiness");
assert.match(layoutPreflight059, /READY_CURRENT[\s\S]*READY_LEGACY/,
  "layout preflight must identify which compatible binding layout was selected");
assert.match(preflight059, /store experience verification rows/,
  "preflight must expose any legacy store EXPERIENCE records for review");
assert.match(preflight059, /teacher-submitted rows attributed to a different teacher/,
  "preflight must expose teacher self-attribution conflicts");
assert.match(preflight059, /non-store\/teacher rows with a selected teacher[\s\S]*role_code NOT IN \('store', 'teacher'\)/,
  "preflight must expose HQ, operation, and any other retired-role attribution");
assert.match(verify059, /trigger\.tgenabled <> 'D'/,
  "readonly verification must reject disabled triggers");
assert.match(verify059, /CURRENT_RECHARGE_INTEGRITY_V58/);
assert.match(verify059, /CURRENT_VERIFICATION_INTEGRITY_V58/);
assert.match(verify059, /STORE_BINDING_CURRENT_V59[\s\S]*STORE_BINDING_LEGACY_V59[\s\S]*STORE_BINDING_DYNAMIC_V59/,
  "final trigger verification must require both dynamically-selected binding paths");
assert.match(layoutVerify059, /has_current OR has_legacy[\s\S]*'READY'/,
  "final layout verification must reject an environment with neither binding layout");
assert.match(readme059, /059-preflight-store-binding-layout\.sql[\s\S]*059-preflight-business-teacher-attribution\.sql[\s\S]*059-00-store-binding-prerequisites\.sql[\s\S]*059-01-business-teacher-function\.sql[\s\S]*059-02-business-teacher-triggers\.sql[\s\S]*059-readonly-verify-store-binding\.sql[\s\S]*059-readonly-verify\.sql/,
  "059 README must preserve the executable order");

console.log("business teacher attribution contract: PASS");
